const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const config = require("./config");
const db = require("./db");
const { SOURCES, EQ_PRESETS, applyPrefs, colorOf, isDJ, nodeIdFor } = require("./music");

const RATES = [0.5, 0.75, 0.85, 1, 1.15, 1.25, 1.5, 2];
const EQ_LABELS = { flat: "Gốc", bass: "Bass mạnh", treble: "Treble sáng", vocal: "Giọng hát nổi", edm: "EDM", lofi: "Lo-fi" };
const HEX = /^#?[0-9a-f]{6}$/i;

const on = (v) => (v ? "Bật" : "Tắt");
const rate = (r) => `${r}x${r === 1 ? " (bình thường)" : ""}`;

const select = (id, placeholder, options, current) =>
  new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(id)
      .setPlaceholder(placeholder)
      .addOptions(options.map((o) => ({ ...o, default: o.value === current }))),
  );

const toggle = (id, label, value) =>
  new ButtonBuilder().setCustomId(id).setLabel(`${label}: ${on(value)}`).setStyle(value ? ButtonStyle.Success : ButtonStyle.Secondary);

// Toàn bộ cài đặt trên một bảng: menu chọn + nút, bấm là lưu và cập nhật ngay.
exports.view = (guildId) => {
  const s = db.getSettings(guildId);
  const source = s.source ?? "ytsearch";
  const eq = s.eq ?? "flat";
  const speed = s.speed ?? 1;
  const pitch = s.pitch ?? 1;
  const opus = s.opus === 10 ? 10 : 5;
  const color = s.color ?? config.color.toString(16).padStart(6, "0");

  const embed = new EmbedBuilder()
    .setColor(colorOf(guildId))
    .setTitle("⚙️ Cài đặt server")
    .setDescription(
      [
        `🔎 Nguồn tìm nhạc: **${SOURCES.find((x) => x.value === source).name}**`,
        `🎛️ Âm sắc: **${EQ_LABELS[eq] ?? eq}**`,
        `⏱️ Tốc độ: **${speed}x** • Cao độ: **${pitch}x**`,
        `🎨 Màu embed: **#${color}**`,
        ...(config.lavalinkHq ? [`🎚️ Chất lượng Opus: **${opus}** (${opus === 10 ? "cao nhất, tốn CPU" : "cân bằng"})`] : []),
        `📢 Thông báo bài mới: **${on(s.announce)}** • ♾️ Autoplay: **${on(s.autoplay)}**`,
        "",
        `🔊 Âm lượng: **${s.volume ?? config.defaultVolume}%** • 🌙 24/7: **${on(s.always_on)}** • 🎧 DJ: ${s.dj_role ? `<@&${s.dj_role}>` : "ai cũng được"}`,
      ].join("\n"),
    )
    .setFooter({ text: "Âm lượng: /volume • 24/7: /247 • Role DJ: /dj" });

  const components = [
    select("s:source", "Nguồn tìm nhạc", SOURCES.map((x) => ({ label: `Nguồn: ${x.name}`, value: x.value })), source),
    select("s:eq", "Âm sắc", Object.keys(EQ_PRESETS).map((k) => ({ label: `Âm sắc: ${EQ_LABELS[k] ?? k}`, value: k })), eq),
    select("s:speed", "Tốc độ", RATES.map((r) => ({ label: `Tốc độ: ${rate(r)}`, value: String(r) })), String(speed)),
    select("s:pitch", "Cao độ", RATES.map((r) => ({ label: `Cao độ: ${rate(r)}`, value: String(r) })), String(pitch)),
    new ActionRowBuilder().addComponents(
      toggle("s:announce", "📢 Thông báo", s.announce),
      toggle("s:autoplay", "♾️ Autoplay", s.autoplay),
      ...(config.lavalinkHq
        ? [new ButtonBuilder().setCustomId("s:opus").setLabel(`🎚️ Opus: ${opus}`).setStyle(opus === 10 ? ButtonStyle.Success : ButtonStyle.Secondary)]
        : []),
      new ButtonBuilder().setCustomId("s:color").setLabel("🎨 Đổi màu").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("s:reset").setLabel("♻️ Đặt lại").setStyle(ButtonStyle.Danger),
    ),
  ];
  return { embeds: [embed], components };
};

const colorModal = () =>
  new ModalBuilder()
    .setCustomId("s:colormodal")
    .setTitle("Màu embed")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("hex")
          .setLabel("Mã màu hex (vd #ff6b9d)")
          .setStyle(TextInputStyle.Short)
          .setMinLength(6)
          .setMaxLength(7)
          .setRequired(true),
      ),
    );

const refuse = (i, text) => i.reply({ content: `❌ ${text}`, flags: MessageFlags.Ephemeral });

// Menu / nút / modal có customId bắt đầu bằng "s:".
exports.handle = async (i) => {
  if (!isDJ(i.member)) return refuse(i, "Chỉ role DJ chỉnh được cài đặt.");
  const guildId = i.guildId;
  const set = (col, value) => db.setSetting(guildId, col, value);
  const current = db.getSettings(guildId);
  const player = i.client.lavalink.getPlayer(guildId);
  const action = i.customId.slice(2);
  const picked = i.values?.[0];

  if (action === "color") return i.showModal(colorModal());

  if (action === "source") {
    if (!SOURCES.some((x) => x.value === picked)) return refuse(i, "Nguồn không hợp lệ.");
    set("source", picked);
  } else if (action === "eq") {
    if (!(picked in EQ_PRESETS)) return refuse(i, "Âm sắc không hợp lệ.");
    set("eq", picked);
  } else if (action === "speed" || action === "pitch") {
    if (!RATES.includes(Number(picked))) return refuse(i, "Giá trị không hợp lệ.");
    set(action, Number(picked));
  } else if (action === "opus") {
    if (!config.lavalinkHq) return refuse(i, "Chưa cấu hình node Opus 10.");
    const target = current.opus === 10 ? 5 : 10;
    if (target === 10 && !i.client.lavalink.nodeManager.nodes.get("hq")?.connected) return refuse(i, "Node Opus 10 chưa sẵn sàng, thử lại sau ít giây.");
    set("opus", target);
    // Chuyển bài đang phát sang node tương ứng (giữ nguyên vị trí và hàng chờ)
    const nodeId = nodeIdFor(i.client.lavalink, guildId);
    // checkSources=false: hai node giống hệt nhau, còn bài nạp "lười" mang sourceName "ytsearch" nên bị từ chối oan
    if (player && player.node.id !== nodeId) await player.changeNode(nodeId, false).catch((e) => console.error("[opus]", e.message));
  } else if (action === "announce") set("announce", current.announce ? 0 : 1);
  else if (action === "autoplay") set("autoplay", current.autoplay ? 0 : 1);
  else if (action === "colormodal") {
    const hex = i.fields.getTextInputValue("hex").trim();
    if (!HEX.test(hex)) return refuse(i, "Mã màu không hợp lệ, ví dụ: #ff6b9d");
    set("color", hex.replace("#", "").toLowerCase());
  } else if (action === "reset") {
    for (const col of ["source", "eq", "speed", "pitch", "color", "opus"]) set(col, null);
    set("announce", 1);
    await player?.filterManager.resetFilters();
    if (player && player.node.id !== nodeIdFor(i.client.lavalink, guildId)) await player.changeNode("main", false).catch((e) => console.error("[opus]", e.message));
  }

  // EQ / tốc độ / cao độ áp ngay lên bài đang phát
  if (player && ["eq", "speed", "pitch"].includes(action)) await applyPrefs(player);
  return i.update(exports.view(guildId));
};
