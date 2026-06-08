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

// ─── Detecta confirmação via OpenAI ──────────────────────────────────────────
async function isConfirmationMessage(text) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 10,
    messages: [
      {
        role: "system",
        content: `Você é um classificador de mensagens de WhatsApp de vendas.
Analise a mensagem e responda APENAS com "SIM" ou "NÃO".
A mensagem indica que o cliente confirmou que já entrou em contato, já chamou, já mandou mensagem, já confirmou presença ou agendamento?

Exemplos SIM: "já chamei", "já mandei mensagem", "já confirmei", "já entrei em contato", "mandei sim", "chamei lá", "já fiz isso", "feito", "ok já chamei", "acabei de chamar"
Exemplos NÃO: "tudo bem", "quanto custa?", "quando é?", "pode me ajudar?", "obrigado"`,
      },
      { role: "user", content: text },
    ],
  });

  const answer = response.choices[0].message.content.trim().toUpperCase();
  return answer === "SIM";
}

// ─── Extrai dados do agendamento via OpenAI ───────────────────────────────────
async function extractScheduleData(conversationTitle, messages) {
  const agentMessages = messages
    .filter((m) => m.message_type === 1)
    .slice(-10)
    .map((m) => m.content)
    .join("\n---\n");

  const context = `TÍTULO DA CONVERSA: ${conversationTitle || "sem título"}

ÚLTIMAS MENSAGENS DO AGENTE:
${agentMessages || "nenhuma"}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 200,
    messages: [
      {
        role: "system",
        content: `Extraia os dados de agendamento do contexto e responda APENAS em JSON válido, sem markdown.
Se não encontrar um campo, use null.
Formato: {"lead_name": "Nome do Lead", "call_date": "DD/MM/YYYY", "call_time": "HH:MM", "closer_name": "Nome do Closer"}`,
      },
      { role: "user", content: context },
    ],
  });

  try {
    const raw = response.choices[0].message.content.trim();
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return { lead_name: null, call_date: null, call_time: null, closer_name: null };
  }
}

// ─── Busca mensagens da conversa no Chatwoot ──────────────────────────────────
async function getConversationMessages(conversationId) {
  const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`;
  const response = await axios.get(url, {
    headers: { api_access_token: CHATWOOT_API_TOKEN },
  });
  return response.data.payload || [];
}

// ─── Busca detalhes da conversa no Chatwoot ───────────────────────────────────
async function getConversation(conversationId) {
  const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`;
  const response = await axios.get(url, {
    headers: { api_access_token: CHATWOOT_API_TOKEN },
  });
  return response.data;
}

// ─── Envia notificação para o Slack ──────────────────────────────────────────
async function sendSlackNotification(data, conversationId) {
  const { lead_name, call_date, call_time, closer_name } = data;
  const chatwootLink = `${CHATWOOT_BASE_URL}/app/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`;

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "✅ Agendamento Confirmado!", emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Lead:*\n${lead_name || "Não identificado"}` },
        { type: "mrkdwn", text: `*Closer:*\n${closer_name || "Não identificado"}` },
        { type: "mrkdwn", text: `*Data da Call:*\n${call_date || "Não identificada"}` },
        { type: "mrkdwn", text: `*Horário:*\n${call_time || "Não identificado"}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Status:* 🟢 CONFIRMADO` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Ver conversa no Chatwoot", emoji: true },
          url: chatwootLink,
          style: "primary",
        },
      ],
    },
    { type: "divider" },
  ];

  await axios.post(SLACK_WEBHOOK_URL, { blocks });
}

// ─── Webhook principal ────────────────────────────────────────────────────────
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
    if (!isConfirmation) {
      console.log(`→ Não é confirmação. Ignorando.`);
      return res.sendStatus(200);
    }

    console.log(`→ CONFIRMAÇÃO detectada! Buscando dados...`);

    const [conversation, messages] = await Promise.all([
      getConversation(conversationId),
      getConversationMessages(conversationId),
    ]);

    const conversationTitle = conversation?.meta?.sender?.name || conversation?.title || null;
    const scheduleData = await extractScheduleData(conversationTitle, messages);

    if (!scheduleData.lead_name) {
      scheduleData.lead_name =
        conversation?.meta?.sender?.name ||
        conversation?.contact?.name ||
        null;
    }

    console.log(`→ Dados extraídos:`, scheduleData);

    await sendSlackNotification(scheduleData, conversationId);
    console.log(`→ Notificação enviada ao Slack!`);

    return res.sendStatus(200);
  } catch (err) {
    console.error("Erro no webhook:", err?.response?.data || err.message);
    return res.sendStatus(500);
  }
});

app.get("/", (req, res) => res.json({ status: "ok", service: "reconecta-webhook" }));

app.listen(PORT, () => {
  console.log(`🚀 Reconecta Webhook rodando na porta ${PORT}`);
});
