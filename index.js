require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

const {
  CHATWOOT_API_TOKEN,
  CHATWOOT_BASE_URL,
  CHATWOOT_ACCOUNT_ID,
  SLACK_WEBHOOK_URL,
  OPENAI_API_KEY,
  PORT = 3000,
} = process.env;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const dailyConfirmations = {};

function getTodayKey() {
  const now = new Date();
  return now.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function saveConfirmation(data, conversationId) {
  const today = getTodayKey();
  const closer = data.closer_name || "Closer não identificado";
  if (!dailyConfirmations[today]) dailyConfirmations[today] = {};
  if (!dailyConfirmations[today][closer]) dailyConfirmations[today][closer] = [];
  dailyConfirmations[today][closer].push({
    lead: data.lead_name || "Lead não identificado",
    call_date: data.call_date || "—",
    call_time: data.call_time || "—",
    confirmed_at: new Date().toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }),
    conversationId,
  });
}

async function sendHourlyReport() {
  const today = getTodayKey();
  const byCloser = dailyConfirmations[today];
  if (!byCloser || Object.keys(byCloser).length === 0) return;
  const now = new Date().toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  const totalGeral = Object.values(byCloser).reduce((acc, arr) => acc + arr.length, 0);
  const blocks = [
    { type: "header", text: { type: "plain_text", text: `📊 Relatório de Confirmações — ${today} até ${now}`, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `*Total do dia:* ${totalGeral} confirmação${totalGeral !== 1 ? "ões" : ""}` } },
    { type: "divider" },
  ];
  for (const [closer, leads] of Object.entries(byCloser)) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*👤 ${closer}* — ${leads.length} confirmação${leads.length !== 1 ? "ões" : ""}` } });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: leads.map((l) => `• ${l.lead} | Call: ${l.call_date} às ${l.call_time} | Confirmado às ${l.confirmed_at}`).join("\n") } });
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
      { role: "system", content: `Você é um classificador de mensagens de WhatsApp de vendas.\nAnalise a mensagem e responda APENAS com "SIM" ou "NÃO".\nA mensagem indica que o cliente confirmou que já entrou em contato, já chamou, já mandou mensagem, já confirmou presença ou agendamento?\nExemplos SIM: "já chamei", "já mandei mensagem", "já confirmei", "já entrei em contato", "mandei sim", "chamei lá", "já fiz isso", "feito", "ok já chamei", "acabei de chamar"\nExemplos NÃO: "tudo bem", "quanto custa?", "quando é?", "pode me ajudar?", "obrigado"` },
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
  await axios.post(SLACK_WEBHOOK_URL, { blocks: [
    { type: "header", text: { type: "plain_text", text: "✅ Agendamento Confirmado!", emoji: true } },
    { type: "section", fields: [
      { type: "mrkdwn", text: `*Lead:*\n${lead_name || "Não identificado"}` },
      { type: "mrkdwn", text: `*Closer:*\n${closer_name || "Não identificado"}` },
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
    saveConfirmation(scheduleData, conversationId);
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

app.listen(PORT, () => {
  console.log(`🚀 Reconecta Webhook rodando na porta ${PORT}`);
  scheduleHourlyReport();
});
