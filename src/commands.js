const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require("discord.js");
const config = require("./config");
const db = require("./db");
const { fmt, parseTime, nowEmbed, panelRow, isDJ, scheduleLeave, colorOf, EQ_PRESETS, applyPrefs } = require("./music");

// ---------- helpers ----------
const say = (i, content, ephemeral = false) => {
  if (i.deferred) return i.editReply({ content });
  const flags = ephemeral ? MessageFlags.Ephemeral : undefined;
  return i.replied ? i.followUp({ content, flags }) : i.reply({ content, flags });
};
const fail = (i, text) => say(i, `❌ ${text}`, true);

// Lấy player đang chạy; kiểm tra cùng kênh voice và quyền DJ.
async function guard(i, { dj = true } = {}) {
  const player = i.client.lavalink.getPlayer(i.guildId);
  if (!player) return void (await fail(i, "Bot chưa phát nhạc."));
  if (i.member.voice.channelId !== player.voiceChannelId) return void (await fail(i, "Bạn cần ở cùng kênh voice với bot."));
  if (dj && !isDJ(i.member)) return void (await fail(i, "Lệnh này chỉ dành cho role DJ."));
  return player;
}

// Tạo player + vào kênh voice của người gọi lệnh.
async function joinPlayer(i) {
  const vc = i.member.voice.channel;
  if (!vc) return void (await fail(i, "Hãy vào một kênh voice trước."));
  if (!vc.joinable || !vc.speakable) return void (await fail(i, "Bot không có quyền vào hoặc nói trong kênh này."));
  const lava = i.client.lavalink;
  if (!lava.useable) return void (await fail(i, "Chưa kết nối được Lavalink, thử lại sau ít giây."));

  let player = lava.getPlayer(i.guildId);
  if (player && player.voiceChannelId !== vc.id) return void (await fail(i, "Bot đang phát ở kênh voice khác."));
  const created = !player;
  player ??= lava.createPlayer({
    guildId: i.guildId,
    voiceChannelId: vc.id,
    textChannelId: i.channelId,
    selfDeaf: true,
    volume: db.getSettings(i.guildId).volume ?? config.defaultVolume,
  });
  if (!player.connected) await player.connect();
  if (created) await applyPrefs(player).catch(() => {}); // chỉ là hiệu ứng, lỗi thì vẫn phát nhạc bình thường
  return { player, created };
}

const startIfIdle = (player) => (!player.playing && !player.paused ? player.play() : null);
const isUrl = (q) => /^https?:\/\//.test(q);

const SOURCES = [
  { name: "YouTube", value: "ytsearch" },
  { name: "YouTube Music", value: "ytmsearch" },
  { name: "Spotify", value: "spsearch" },
  { name: "SoundCloud", value: "scsearch" },
];

const FILTERS = {
  off: async () => {},
  bassboost: (fm) => fm.setEQ([0.25, 0.2, 0.15, 0.1, 0.05].map((gain, band) => ({ band, gain }))),
  nightcore: (fm) => fm.toggleNightcore(),
  vaporwave: (fm) => fm.toggleVaporwave(),
  "8d": (fm) => fm.toggleRotation(0.2),
  karaoke: (fm) => fm.toggleKaraoke(),
};

// ---------- commands ----------
const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("play")
      .setDescription("Phát nhạc từ tên bài hoặc link YouTube / Spotify / SoundCloud")
      .addStringOption((o) => o.setName("query").setDescription("Tên bài hoặc link").setRequired(true))
      .addStringOption((o) =>
        o
          .setName("source")
          .setDescription("Nguồn khi tìm theo tên (mặc định: theo /settings source)")
          .addChoices(...SOURCES),
      )
      .addBooleanOption((o) => o.setName("next").setDescription("Chèn lên đầu hàng chờ")),
    async run(i) {
      await i.deferReply();
      const joined = await joinPlayer(i);
      if (!joined) return;
      const { player, created } = joined;

      const query = i.options.getString("query");
      const source = i.options.getString("source") ?? db.getSettings(i.guildId).source ?? "ytsearch";
      const res = await player.search(isUrl(query) ? { query } : { query, source }, i.user);

      if (res.loadType === "error" || res.loadType === "empty" || !res.tracks.length) {
        if (created) await player.destroy("Không tìm thấy bài");
        return say(i, "❌ Không tìm thấy bài nào.");
      }
      const isPlaylist = res.loadType === "playlist";
      const tracks = isPlaylist ? res.tracks : [res.tracks[0]];
      if (i.options.getBoolean("next")) await player.queue.splice(0, 0, tracks);
      else await player.queue.add(tracks);
      await startIfIdle(player);

      return say(
        i,
        isPlaylist
          ? `📃 Đã thêm playlist **${res.playlist?.title ?? "?"}** (${tracks.length} bài)`
          : `➕ Đã thêm **${tracks[0].info.title}**`,
      );
    },
  },
  {
    data: new SlashCommandBuilder().setName("skip").setDescription("Bỏ qua bài hiện tại"),
    async run(i) {
      const player = await guard(i);
      if (!player) return;
      const title = player.queue.current?.info.title ?? "bài hiện tại";
      if (player.queue.tracks.length) await player.skip();
      else await player.stopPlaying(true, false);
      return say(i, `⏭️ Đã bỏ qua **${title}**`);
    },
  },
  {
    data: new SlashCommandBuilder().setName("stop").setDescription("Dừng nhạc, xóa hàng chờ và rời kênh"),
    async run(i) {
      const player = await guard(i);
      if (!player) return;
      if (db.getSettings(i.guildId).always_on) await player.stopPlaying(true, false);
      else await player.destroy("Lệnh /stop");
      return say(i, "⏹️ Đã dừng phát nhạc.");
    },
  },
  {
    data: new SlashCommandBuilder().setName("pause").setDescription("Tạm dừng"),
    async run(i) {
      const player = await guard(i);
      if (!player) return;
      await player.pause();
      return say(i, "⏸️ Đã tạm dừng.");
    },
  },
  {
    data: new SlashCommandBuilder().setName("resume").setDescription("Tiếp tục phát"),
    async run(i) {
      const player = await guard(i);
      if (!player) return;
      await player.resume();
      return say(i, "▶️ Tiếp tục phát.");
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("queue")
      .setDescription("Xem hàng chờ")
      .addIntegerOption((o) => o.setName("page").setDescription("Trang").setMinValue(1)),
    async run(i) {
      const player = await guard(i, { dj: false });
      if (!player) return;
      const { current, tracks } = player.queue;
      const pages = Math.max(1, Math.ceil(tracks.length / 10));
      const page = Math.min(i.options.getInteger("page") ?? 1, pages);
      const lines = tracks
        .slice((page - 1) * 10, page * 10)
        .map((t, n) => `\`${(page - 1) * 10 + n + 1}.\` [${t.info.title.slice(0, 60)}](${t.info.uri}) — ${fmt(t.info.duration)}`);
      const total = tracks.reduce((sum, t) => sum + (t.info.isStream ? 0 : t.info.duration), 0);

      const embed = new EmbedBuilder()
        .setColor(colorOf(i.guildId))
        .setTitle("Hàng chờ")
        .setDescription(
          `**Đang phát:** ${current ? `[${current.info.title}](${current.info.uri})` : "không có"}\n\n${lines.join("\n") || "Hàng chờ trống."}`,
        )
        .setFooter({ text: `Trang ${page}/${pages} • ${tracks.length} bài • ${fmt(total)}` });
      return i.reply({ embeds: [embed] });
    },
  },
  {
    data: new SlashCommandBuilder().setName("nowplaying").setDescription("Bài đang phát"),
    async run(i) {
      const player = await guard(i, { dj: false });
      if (!player) return;
      const track = player.queue.current;
      if (!track) return fail(i, "Chưa có bài nào đang phát.");
      const embed = nowEmbed(player, track);
      if (!track.info.isStream) {
        const ratio = Math.min(1, player.position / track.info.duration);
        const at = Math.round(ratio * 20);
        embed.setDescription(`\`${fmt(player.position)}\` ${"▬".repeat(at)}🔘${"▬".repeat(20 - at)} \`${fmt(track.info.duration)}\``);
      }
      return i.reply({ embeds: [embed], components: [panelRow(player)] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("loop")
      .setDescription("Chế độ lặp")
      .addStringOption((o) =>
        o
          .setName("mode")
          .setDescription("Chế độ")
          .setRequired(true)
          .addChoices(
            { name: "Tắt", value: "off" },
            { name: "Lặp bài hiện tại", value: "track" },
            { name: "Lặp cả hàng chờ", value: "queue" },
          ),
      ),
    async run(i) {
      const player = await guard(i);
      if (!player) return;
      const mode = i.options.getString("mode");
      await player.setRepeatMode(mode);
      return say(i, `🔁 Chế độ lặp: **${mode}**`);
    },
  },
  {
    data: new SlashCommandBuilder().setName("shuffle").setDescription("Xáo trộn hàng chờ"),
    async run(i) {
      const player = await guard(i);
      if (!player) return;
      await player.queue.shuffle();
      return say(i, "🔀 Đã xáo trộn hàng chờ.");
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("volume")
      .setDescription("Chỉnh âm lượng (lưu cho server)")
      .addIntegerOption((o) => o.setName("level").setDescription("1-150").setRequired(true).setMinValue(1).setMaxValue(150)),
    async run(i) {
      const player = await guard(i);
      if (!player) return;
      const level = i.options.getInteger("level");
      await player.setVolume(level);
      db.setSetting(i.guildId, "volume", level);
      return say(i, `🔊 Âm lượng: **${level}%**`);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("seek")
      .setDescription("Tua tới vị trí (vd 90, 1:30, 1:02:03)")
      .addStringOption((o) => o.setName("time").setDescription("Vị trí").setRequired(true)),
    async run(i) {
      const player = await guard(i);
      if (!player) return;
      const track = player.queue.current;
      const ms = parseTime(i.options.getString("time"));
      if (!track?.info.isSeekable) return fail(i, "Bài này không tua được.");
      if (ms === null || ms >= track.info.duration) return fail(i, "Thời gian không hợp lệ.");
      await player.seek(ms);
      return say(i, `⏩ Đã tua tới **${fmt(ms)}**`);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("remove")
      .setDescription("Xóa một bài khỏi hàng chờ")
      .addIntegerOption((o) => o.setName("position").setDescription("Số thứ tự trong /queue").setRequired(true).setMinValue(1)),
    async run(i) {
      const player = await guard(i);
      if (!player) return;
      const index = i.options.getInteger("position") - 1;
      const track = player.queue.tracks[index];
      if (!track) return fail(i, "Không có bài ở vị trí đó.");
      await player.queue.remove(index);
      return say(i, `🗑️ Đã xóa **${track.info.title}**`);
    },
  },
  {
    data: new SlashCommandBuilder().setName("clear").setDescription("Xóa toàn bộ hàng chờ (giữ bài đang phát)"),
    async run(i) {
      const player = await guard(i);
      if (!player) return;
      await player.queue.splice(0, player.queue.tracks.length);
      return say(i, "🧹 Đã xóa hàng chờ.");
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("filter")
      .setDescription("Hiệu ứng âm thanh")
      .addStringOption((o) =>
        o
          .setName("name")
          .setDescription("Hiệu ứng")
          .setRequired(true)
          .addChoices(...Object.keys(FILTERS).map((k) => ({ name: k === "off" ? "Tắt tất cả" : k, value: k }))),
      ),
    async run(i) {
      const player = await guard(i);
      if (!player) return;
      const name = i.options.getString("name");
      const fm = player.filterManager;
      await fm.resetFilters(); // luôn chỉ bật 1 hiệu ứng
      await fm.clearEQ?.();
      await FILTERS[name](fm);
      return say(i, name === "off" ? "🎚️ Đã tắt hiệu ứng." : `🎚️ Đã bật hiệu ứng **${name}**`);
    },
  },
  {
    data: new SlashCommandBuilder().setName("autoplay").setDescription("Bật/tắt tự phát bài tương tự khi hết hàng chờ"),
    async run(i) {
      if (!isDJ(i.member)) return fail(i, "Lệnh này chỉ dành cho role DJ.");
      const on = !db.getSettings(i.guildId).autoplay;
      db.setSetting(i.guildId, "autoplay", on ? 1 : 0);
      return say(i, `♾️ Autoplay: **${on ? "BẬT" : "TẮT"}**`);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("247")
      .setDescription("Bật/tắt chế độ 24/7 (bot ở lại kênh voice của bạn)")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    async run(i) {
      const on = !db.getSettings(i.guildId).always_on;
      if (on) {
        await i.deferReply();
        const joined = await joinPlayer(i);
        if (!joined) return;
        db.setSetting(i.guildId, "always_on", 1);
        db.setSetting(i.guildId, "voice_channel", joined.player.voiceChannelId);
        db.setSetting(i.guildId, "text_channel", i.channelId);
        return say(i, "🌙 Chế độ 24/7: **BẬT**. Bot sẽ ở lại kênh voice này kể cả khi hết nhạc.");
      }
      db.setSetting(i.guildId, "always_on", 0);
      db.setSetting(i.guildId, "voice_channel", null);
      const player = i.client.lavalink.getPlayer(i.guildId);
      if (player) scheduleLeave(player);
      return say(i, "🌙 Chế độ 24/7: **TẮT**.");
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("dj")
      .setDescription("Đặt role DJ (bỏ trống để cho mọi người điều khiển)")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addRoleOption((o) => o.setName("role").setDescription("Role DJ")),
    async run(i) {
      const role = i.options.getRole("role");
      db.setSetting(i.guildId, "dj_role", role?.id ?? null);
      return say(i, role ? `🎧 Role DJ: ${role}` : "🎧 Đã bỏ role DJ, ai cũng điều khiển được.");
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("settings")
      .setDescription("Tùy chỉnh bot cho server này")
      .addSubcommand((s) => s.setName("show").setDescription("Xem cài đặt hiện tại"))
      .addSubcommand((s) =>
        s
          .setName("source")
          .setDescription("Nguồn mặc định khi /play theo tên (YouTube Music thường sạch tiếng hơn)")
          .addStringOption((o) => o.setName("name").setDescription("Nguồn").setRequired(true).addChoices(...SOURCES)),
      )
      .addSubcommand((s) =>
        s
          .setName("eq")
          .setDescription("Âm sắc (equalizer)")
          .addStringOption((o) =>
            o
              .setName("preset")
              .setDescription("Kiểu âm")
              .setRequired(true)
              .addChoices(...Object.keys(EQ_PRESETS).map((k) => ({ name: k, value: k }))),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("tempo")
          .setDescription("Tốc độ và cao độ (vd slowed: speed 0.85, nightcore nhẹ: speed 1.2 pitch 1.2)")
          .addNumberOption((o) => o.setName("speed").setDescription("0.5-2, 1 = bình thường").setMinValue(0.5).setMaxValue(2))
          .addNumberOption((o) => o.setName("pitch").setDescription("0.5-2, 1 = bình thường").setMinValue(0.5).setMaxValue(2)),
      )
      .addSubcommand((s) =>
        s
          .setName("color")
          .setDescription("Màu embed")
          .addStringOption((o) => o.setName("hex").setDescription("Mã màu, vd #ff6b9d").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("announce")
          .setDescription("Bật/tắt tin nhắn \"Đang phát\" mỗi khi sang bài mới")
          .addBooleanOption((o) => o.setName("on").setDescription("Bật hay tắt").setRequired(true)),
      )
      .addSubcommand((s) => s.setName("reset").setDescription("Đưa tất cả tùy chỉnh về mặc định")),
    async run(i) {
      if (!isDJ(i.member)) return fail(i, "Lệnh này chỉ dành cho role DJ.");
      const sub = i.options.getSubcommand();
      const set = (col, value) => db.setSetting(i.guildId, col, value);
      const player = i.client.lavalink.getPlayer(i.guildId);

      if (sub === "show") {
        const s = db.getSettings(i.guildId);
        const on = (v) => (v ? "Bật" : "Tắt");
        const lines = [
          `Nguồn mặc định: **${SOURCES.find((x) => x.value === (s.source ?? "ytsearch")).name}**`,
          `EQ: **${s.eq ?? "flat"}**`,
          `Tốc độ / cao độ: **${s.speed ?? 1}x / ${s.pitch ?? 1}x**`,
          `Màu embed: **#${s.color ?? config.color.toString(16).padStart(6, "0")}**`,
          `Thông báo bài mới: **${on(s.announce)}**`,
          `Âm lượng: **${s.volume ?? config.defaultVolume}%** • Autoplay: **${on(s.autoplay)}** • 24/7: **${on(s.always_on)}** • DJ: ${s.dj_role ? `<@&${s.dj_role}>` : "ai cũng được"}`,
        ];
        const embed = new EmbedBuilder()
          .setColor(colorOf(i.guildId))
          .setTitle("Cài đặt server")
          .setDescription(lines.join("\n"))
          .setFooter({ text: "Chất lượng Opus/resample chỉnh ở Lavalink: LAVALINK_OPUS_QUALITY, LAVALINK_RESAMPLING" });
        return i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      if (sub === "source") {
        const name = i.options.getString("name");
        set("source", name);
        return say(i, `🔎 Nguồn mặc định: **${SOURCES.find((x) => x.value === name).name}**`);
      }
      if (sub === "eq") {
        const preset = i.options.getString("preset");
        set("eq", preset);
        if (player) await applyPrefs(player);
        return say(i, `🎛️ EQ: **${preset}**${player ? "" : " (áp dụng từ lần phát tới)"}`);
      }
      if (sub === "tempo") {
        const speed = i.options.getNumber("speed");
        const pitch = i.options.getNumber("pitch");
        if (speed === null && pitch === null) return fail(i, "Nhập ít nhất speed hoặc pitch.");
        if (speed !== null) set("speed", speed);
        if (pitch !== null) set("pitch", pitch);
        if (player) await applyPrefs(player);
        return say(i, `⏱️ Tốc độ: **${speed ?? db.getSettings(i.guildId).speed ?? 1}x** • Cao độ: **${pitch ?? db.getSettings(i.guildId).pitch ?? 1}x**`);
      }
      if (sub === "color") {
        const hex = i.options.getString("hex").trim();
        if (!/^#?[0-9a-f]{6}$/i.test(hex)) return fail(i, "Mã màu không hợp lệ, ví dụ: #ff6b9d");
        set("color", hex.replace("#", "").toLowerCase());
        return i.reply({ embeds: [new EmbedBuilder().setColor(colorOf(i.guildId)).setDescription("🎨 Đã đổi màu embed.")] });
      }
      if (sub === "announce") {
        const value = i.options.getBoolean("on");
        set("announce", value ? 1 : 0);
        return say(i, `📢 Thông báo bài mới: **${value ? "BẬT" : "TẮT"}**`);
      }

      // reset
      for (const col of ["source", "eq", "speed", "pitch", "color"]) set(col, null);
      set("announce", 1);
      if (player) await player.filterManager.resetFilters();
      return say(i, "♻️ Đã đưa tùy chỉnh về mặc định.");
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("playlist")
      .setDescription("Playlist cá nhân")
      .addSubcommand((s) =>
        s
          .setName("save")
          .setDescription("Lưu hàng chờ hiện tại thành playlist")
          .addStringOption((o) => o.setName("name").setDescription("Tên playlist").setRequired(true).setMaxLength(32)),
      )
      .addSubcommand((s) =>
        s
          .setName("load")
          .setDescription("Thêm playlist đã lưu vào hàng chờ")
          .addStringOption((o) => o.setName("name").setDescription("Tên playlist").setRequired(true).setAutocomplete(true)),
      )
      .addSubcommand((s) => s.setName("list").setDescription("Danh sách playlist của bạn"))
      .addSubcommand((s) =>
        s
          .setName("delete")
          .setDescription("Xóa playlist")
          .addStringOption((o) => o.setName("name").setDescription("Tên playlist").setRequired(true).setAutocomplete(true)),
      ),
    async run(i) {
      const sub = i.options.getSubcommand();
      const name = i.options.getString("name");

      if (sub === "list") {
        const rows = db.listPlaylists(i.user.id);
        return say(i, rows.length ? rows.map((r) => `• **${r.name}** — ${r.count} bài`).join("\n") : "Bạn chưa có playlist nào.", true);
      }
      if (sub === "delete") {
        return say(i, db.deletePlaylist(i.user.id, name) ? `🗑️ Đã xóa **${name}**` : "❌ Không có playlist đó.", true);
      }
      if (sub === "save") {
        const player = await guard(i, { dj: false });
        if (!player) return;
        const all = [player.queue.current, ...player.queue.tracks].filter((t) => t?.info.uri);
        if (!all.length) return fail(i, "Không có bài nào để lưu.");
        if (!db.getPlaylist(i.user.id, name) && db.listPlaylists(i.user.id).length >= 25) return fail(i, "Tối đa 25 playlist.");
        db.savePlaylist(i.user.id, name, all.slice(0, 100).map((t) => ({ uri: t.info.uri, title: t.info.title })));
        return say(i, `💾 Đã lưu **${Math.min(all.length, 100)}** bài vào playlist **${name}**`, true);
      }

      // load
      const saved = db.getPlaylist(i.user.id, name);
      if (!saved) return fail(i, "Không có playlist đó.");
      await i.deferReply();
      const joined = await joinPlayer(i);
      if (!joined) return;
      const { player, created } = joined;
      let added = 0;
      for (const t of saved.slice(0, 50)) {
        const res = await player.search({ query: t.uri }, i.user).catch(() => null);
        if (!res?.tracks.length) continue;
        await player.queue.add(res.tracks[0]);
        added++;
        await startIfIdle(player); // nghe được ngay từ bài đầu, phần còn lại nạp dần
      }
      if (!added && created) await player.destroy("Playlist rỗng");
      return say(i, added ? `📂 Đã nạp **${added}** bài từ playlist **${name}**` : "❌ Không nạp được bài nào.");
    },
  },
];

exports.list = commands;
exports.byName = new Map(commands.map((c) => [c.data.name, c]));

exports.autocomplete = async (i) => {
  const typed = i.options.getFocused().toLowerCase();
  const choices = db
    .listPlaylists(i.user.id)
    .filter((p) => p.name.toLowerCase().startsWith(typed))
    .slice(0, 25)
    .map((p) => ({ name: `${p.name} (${p.count})`, value: p.name }));
  return i.respond(choices);
};

// Các nút dưới tin nhắn "Đang phát"
exports.button = async (i) => {
  const player = await guard(i);
  if (!player) return;
  const action = i.customId.slice(2);
  const nextLoop = { off: "track", track: "queue", queue: "off" };

  if (action === "pause") await (player.paused ? player.resume() : player.pause());
  else if (action === "loop") await player.setRepeatMode(nextLoop[player.repeatMode]);
  else if (action === "shuffle") await player.queue.shuffle();
  else if (action === "skip") await (player.queue.tracks.length ? player.skip() : player.stopPlaying(true, false));
  else if (action === "stop") {
    await (db.getSettings(i.guildId).always_on ? player.stopPlaying(true, false) : player.destroy("Nút dừng"));
  }

  const current = player.queue.current;
  if (current && ["pause", "loop", "shuffle"].includes(action)) {
    return i.update({ embeds: [nowEmbed(player, current)], components: [panelRow(player)] });
  }
  return i.deferUpdate();
};
