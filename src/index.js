// Message Content là intent đặc quyền: chỉ xin khi đã bật trong Developer Portal, nếu không Discord từ chối đăng nhập
// và bot không lên được. Chưa bật thì bot vẫn chạy với lệnh "/" và báo trong log.
const config = require("./config");

const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19; // bot chưa xác minh (dưới 100 server) bật công tắc sẽ ra cờ này

async function messageContentEnabled() {
  try {
    const res = await fetch("https://discord.com/api/v10/applications/@me", {
      headers: { Authorization: `Bot ${config.token}` },
      signal: AbortSignal.timeout(8000),
    });
    const { flags = 0 } = await res.json();
    return Boolean(flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED));
  } catch {
    return false;
  }
}

(async () => {
  config.messageContent = Boolean(config.prefix) && (await messageContentEnabled());
  if (config.prefix && !config.messageContent) {
    console.warn(
      `[prefix] Message Content Intent chưa bật nên lệnh "${config.prefix}" tạm không dùng được (lệnh "/" vẫn chạy). ` +
        "Bật ở Developer Portal > Bot > Message Content Intent rồi khởi động lại bot.",
    );
  }
  require("./bot");
})();
