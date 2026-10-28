const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, StringSelectMenuBuilder } = require("discord.js");
const config = require("./config");
const db = require("./db");
const { SOURCES, EQ_PRESETS, applyPrefs, colorOf, isDJ, nodeIdFor } = require("./music");

const EQ_LABELS = { flat: "Gốc", bass: "Bass mạnh", treble: "Treble sáng", vocal: "Giọng hát nổi", edm: "EDM", lofi: "Lo-fi" };

const on = (v) => (v ? "Bật" : "Tắt");

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
  const opus = s.opus === 10 ? 10 : 5;

  const embed = new EmbedBuilder()
    .setColor(colorOf(guildId))
    .setTitle("⚙️ Cài đặt server")
    .setDescription(
      [
        `🔎 Nguồn: **${SOURCES.find((x) => x.value === source).name}** • 🎛️ Âm sắc: **${EQ_LABELS[eq] ?? eq}**`,
        `🔊 Âm lượng: **${s.volume ?? config.defaultVolume}%** • 🌙 24/7: **${on(s.always_on)}** • 🎧 DJ: ${s.dj_role ? `<@&${s.dj_role}>` : "ai cũng được"}`,
      ].join("\n"),
    )
    .setFooter({ text: "Âm lượng: /volume • 24/7: /247 • Role DJ: /dj" });

  const components = [
    select("s:source", "Nguồn tìm nhạc", SOURCES.map((x) => ({ label: `Nguồn: ${x.name}`, value: x.value })), source),
    select("s:eq", "Âm sắc", Object.keys(EQ_PRESETS).map((k) => ({ label: `Âm sắc: ${EQ_LABELS[k] ?? k}`, value: k })), eq),
    new ActionRowBuilder().addComponents(
      toggle("s:announce", "📢 Thông báo", s.announce),
      toggle("s:autoplay", "♾️ Autoplay", s.autoplay),
      ...(config.lavalinkHq
        ? [new ButtonBuilder().setCustomId("s:opus").setLabel(`🎚️ Opus: ${opus}`).setStyle(opus === 10 ? ButtonStyle.Success : ButtonStyle.Secondary)]
        : []),
      new ButtonBuilder().setCustomId("s:reset").setLabel("♻️ Đặt lại").setStyle(ButtonStyle.Danger),
    ),
  ];
  return { embeds: [embed], components };
};

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

  if (action === "source") {
    if (!SOURCES.some((x) => x.value === picked)) return refuse(i, "Nguồn không hợp lệ.");
    set("source", picked);
  } else if (action === "eq") {
    if (!(picked in EQ_PRESETS)) return refuse(i, "Âm sắc không hợp lệ.");
    set("eq", picked);
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
  else if (action === "reset") {
    for (const col of ["source", "eq", "speed", "pitch", "color", "opus"]) set(col, null);
    set("announce", 1);
    await player?.filterManager.resetFilters();
    if (player && player.node.id !== nodeIdFor(i.client.lavalink, guildId)) await player.changeNode("main", false).catch((e) => console.error("[opus]", e.message));
  }

  // EQ áp ngay lên bài đang phát
  if (player && action === "eq") await applyPrefs(player);
  return i.update(exports.view(guildId));
};
