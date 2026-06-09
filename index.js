require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const {
  CHATWOOT_API_TOKEN,
  CHATWOOT_BASE_URL,
  CHATWOOT_ACCOUNT_ID,
  SLACK_WEBHOOK_URL,
  OPENAI_API_KEY,
  DATABASE_URL,
  PORT = 3000,
} = process.env;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const CLOSER_SLACK_IDS = {
  "hawinne":  "U0A8HHRPWAY",
  "andrezza": "U0A44MYEV5Y",
  "stefany":  "U0B712LCUUQ",
  "nathan":   "U0AQKCW88KA",
  "leandro":  "U0AQ422CRS5",
  "leonardo": "U0ASKV26U9Z",
};

function getSlackMention(closerName) {
  if (!closerName) return "Closer não identificado";
  const lower = closerName.toLowerCase();
  for (const [key, id] of Object.entries(CLOSER_SLACK_IDS)) {
    if (lower.includes(key)) return `<@${id}>`;
  }
  return closerName;
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS confirmations (
      id SERIAL PRIMARY KEY,
      lead_name TEXT,
      closer_name TEXT,
      call_date TEXT,
      call_time TEXT,
      confirmed_at TIMESTAMPTZ DEFAULT NOW(),
      conversation_id TEXT
    )
  `);
  console.log("✅ Banco de dados pronto.");
}

async function saveConfirmation(data, conversationId) {
  await pool.query(
    `INSERT INTO confirmations (lead_name, closer_name, call_date, call_time, conversation_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [data.lead_name || "Lead não identificado", data.closer_name || "Closer não identificado", data.call_date || null, data.call_time || null, String(conversationId)]
  );
}

async function sendHourlyReport() {
  const result = await pool.query(`
    SELECT closer_name, call_date, call_time, lead_name, confirmed_at, conversation_id
    FROM confirmations
    WHERE call_date IS NOT NULL
    ORDER BY call_date ASC, call_time ASC, closer_name ASC
  `);
  if (result.rows.length === 0) return;

  const byDate = {};
  for (const row of result.rows) {
    const date = row.call_date || "Data não identificada";
    const closer = row.closer_name || "Closer não identificado";
    if (!byDate[date]) byDate[date] = {};
    if (!byDate[date][closer]) byDate[date][closer] = [];
    byDate[date][closer].push(row);
  }

  const now = new Date().toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  const today = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const totalGeral = result.rows.length;

  const blocks = [
    { type: "header", text: { type: "plain_text", text: `📊 Relatório de Confirmações — atualizado ${today} às ${now}`, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `*Total geral:* ${totalGeral} confirmação${totalGeral !== 1 ? "ões" : ""}` } },
    { type: "divider" },
  ];

  for (const [date, closers] of Object.entries(byDate)) {
    const totalDate = Object.values(closers).reduce((acc, arr) => acc + arr.length, 0);
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `📅 *Calls do dia ${date}* — ${totalDate} confirmação${totalDate !== 1 ? "ões" : ""}` } });
    for (const [closer, leads] of Object.entries(closers)) {
      const mention = getSlackMention(closer);
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${mention}* — ${leads.length} confirmação${leads.length !== 1 ? "ões" : ""}` } });
      blocks.push({ type: "section", text: { type: "mrkdwn", text: leads.map((l) => {
        const confirmedAt = new Date(l.confirmed_at).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
        return `• ${l.lead_name} | Horário da call: ${l.call_time || "—"} | Confirmado às ${confirmedAt}`;
      }).join("\n") } });
    }
    blocks.push({ type: "divider" });
  }

  await axios.post(SLACK_WEBHOOK_URL, { blocks });
  console.log(`[${new Date().toISOString()}] Relatório enviado ao Slack.`);
}

function scheduleHourlyReport() {
  const now = new Date();
  const msUntilNextHour = (60 - now.getMinutes()) * 60 * 1000 - now.getSeconds() * 1000 - now.getMilliseconds();
  setTimeout(() => { sendHourlyReport(); setInterval(sendHourlyReport, 60 * 60 * 1000); }, msUntilNextHour);
  console.log(`⏰ Próximo relatório em ${Math.round(msUntilNextHour / 60000)} minutos.`);
}

async function isConfirmationMessage(text) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini", max_tokens: 10,
    messages: [
      { role: "system", content: `Você é um classificador de mensagens de WhatsApp de vendas.\nAnalise a mensagem e responda APENAS com "SIM" ou "NÃO".\nA mensagem indica que o cliente confirmou que já entrou em contato, já chamou, já mandou mensagem, já confirmou presença ou agendamento?\nExemplos SIM: "já chamei", "já mandei mensagem", "já confirmei", "já entrei em contato", "mandei sim", "chamei lá", "já fiz isso", "feito", "ok já chamei", "acabei de chamar", "confirmado", "agendado", "pronto", "já fiz"\nExemplos NÃO: "tudo bem", "quanto custa?", "quando é?", "pode me ajudar?", "obrigado"` },
      { role: "user", content: text },
    ],
  });
  return response.choices[0].message.content.trim().toUpperCase() === "SIM";
}

async function extractScheduleData(conversationTitle, messages) {
  const agentMessages = messages.filter((m) => m.message_type === 1).slice(-10).map((m) => m.content).join("\n---\n");
  const context = `TÍTULO DA CONVERSA: ${conversationTitle || "sem título"}\n\nÚLTIMAS MENSAGENS DO AGENTE:\n${agentMessages || "nenhuma"}`;
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini", max_tokens: 200,
    messages: [
      { role: "system", content: `Extraia os dados de agendamento do contexto e responda APENAS em JSON válido, sem markdown.\nSe não encontrar um campo, use null.\nFormato: {"lead_name": "Nome do Lead", "call_date": "DD/MM/YYYY", "call_time": "HH:MM", "closer_name": "Nome do Closer"}` },
      { role: "user", content: context },
    ],
  });
  try {
    return JSON.parse(response.choices[0].message.content.trim().replace(/```json|```/g, "").trim());
  } catch {
    return { lead_name: null, call_date: null, call_time: null, closer_name: null };
  }
}

async function getConversationMessages(conversationId) {
  const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`;
  const response = await axios.get(url, { headers: { api_access_token: CHATWOOT_API_TOKEN } });
  return response.data.payload || [];
}

async function getConversation(conversationId) {
  const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`;
  const response = await axios.get(url, { headers: { api_access_token: CHATWOOT_API_TOKEN } });
  return response.data;
}

async function sendSlackNotification(data, conversationId) {
  const { lead_name, call_date, call_time, closer_name } = data;
  const chatwootLink = `${CHATWOOT_BASE_URL}/app/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`;
  const mention = getSlackMention(closer_name);
  await axios.post(SLACK_WEBHOOK_URL, { blocks: [
    { type: "header", text: { type: "plain_text", text: "✅ Agendamento Confirmado!", emoji: true } },
    { type: "section", fields: [
      { type: "mrkdwn", text: `*Lead:*\n${lead_name || "Não identificado"}` },
      { type: "mrkdwn", text: `*Closer:*\n${mention}` },
      { type: "mrkdwn", text: `*Data da Call:*\n${call_date || "Não identificada"}` },
      { type: "mrkdwn", text: `*Horário:*\n${call_time || "Não identificado"}` },
    ]},
    { type: "section", text: { type: "mrkdwn", text: `*Status:* 🟢 CONFIRMADO` } },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Ver conversa no Chatwoot", emoji: true }, url: chatwootLink, style: "primary" }] },
    { type: "divider" },
  ]});
}

app.post("/webhook", async (req, res) => {
  try {
    const event = req.body;
    if (event.event !== "message_created") return res.sendStatus(200);
    if (event.message_type !== "incoming") return res.sendStatus(200);
    const messageText = event.content;
    if (!messageText || messageText.trim() === "") return res.sendStatus(200);
    const conversationId = event.conversation?.id || event.id;
    if (!conversationId) return res.sendStatus(200);
    console.log(`[${new Date().toISOString()}] Nova mensagem: "${messageText}" | Conversa: ${conversationId}`);
    const isConfirmation = await isConfirmationMessage(messageText);
    if (!isConfirmation) { console.log(`→ Não é confirmação. Ignorando.`); return res.sendStatus(200); }
    console.log(`→ CONFIRMAÇÃO detectada! Buscando dados...`);
    const [conversation, messages] = await Promise.all([getConversation(conversationId), getConversationMessages(conversationId)]);
    const conversationTitle = conversation?.meta?.sender?.name || conversation?.title || null;
    const scheduleData = await extractScheduleData(conversationTitle, messages);
    if (!scheduleData.lead_name) scheduleData.lead_name = conversation?.meta?.sender?.name || conversation?.contact?.name || null;
    console.log(`→ Dados extraídos:`, scheduleData);
    await saveConfirmation(scheduleData, conversationId);
    await sendSlackNotification(scheduleData, conversationId);
    console.log(`→ Notificação enviada ao Slack!`);
    return res.sendStatus(200);
  } catch (err) {
    console.error("Erro no webhook:", err?.response?.data || err.message);
    return res.sendStatus(500);
  }
});

app.get("/", (req, res) => res.json({ status: "ok", service: "reconecta-webhook" }));

app.get("/relatorio", async (req, res) => {
  try {
    await sendHourlyReport();
    res.json({ status: "ok", message: "Relatório enviado ao Slack!" });
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`🚀 Reconecta Webhook rodando na porta ${PORT}`);
  await initDB();
  scheduleHourlyReport();
});
