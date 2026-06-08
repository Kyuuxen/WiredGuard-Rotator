const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_URL = process.env.API_URL; 
const SECRET_TOKEN = process.env.SECRET_TOKEN;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function api(path, method = "GET") {
  return axios({
    url: `${API_URL}${path}`,
    method,
    headers: {
      "x-secret-token": SECRET_TOKEN,
    },
  }).then(r => r.data);
}
bot.onText(/\/status/, async (msg) => {
  const data = await api("/status");
  bot.sendMessage(msg.chat.id,
    `🟢 VPN Status
Configs: ${data.configs_loaded}
Rotation: ${data.rotation_count}
Country: ${data.current_country}
Next: ${data.next_rotation}`
  );
});
bot.onText(/\/current/, async (msg) => {
  const data = await api("/endpoint");

  bot.sendMessage(msg.chat.id,
    `🌍 Current VPN
IP: ${data.ip}
Port: ${data.port}
Country: ${data.country}
Rotation #: ${data.rotation}`
  );
});
bot.onText(/\/rotate/, async (msg) => {
  const data = await api("/endpoint/rotate", "POST");

  bot.sendMessage(msg.chat.id,
    `🔄 Rotated!
New country: ${data.country}
IP: ${data.ip}`
  );
});
bot.onText(/\/download/, async (msg) => {
  const file = await api("/endpoint/config");

  bot.sendMessage(msg.chat.id,
    "📥 Sending current config file..."
  );

  bot.sendDocument(msg.chat.id, Buffer.from(file), {
    filename: "vpn.conf",
  });
});
