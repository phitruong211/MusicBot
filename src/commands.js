const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require("discord.js");
const config = require("./config");
const db = require("./db");
const {
  SOURCES,
  SEEK_STEP_MS,
  fmt,
  parseTime,
  nowEmbed,
  panelRows,
  isDJ,
  scheduleLeave,
  colorOf,
  applyPrefs,
  nodeIdFor,
} = require("./music");
const settings = require("./settings");
const lazy = require("./lazy");

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
    node: nodeIdFor(lava, i.guildId),
  });
  if (!player.connected) await player.connect();
  if (created) await applyPrefs(player).catch(() => {}); // chỉ là hiệu ứng, lỗi thì vẫn phát nhạc bình thường
  return { player, created };
}

const startIfIdle = (player) => (!player.playing && !player.paused ? player.play() : null);
const isUrl = (q) => /^https?:\/\//.test(q);

// Trang embed Spotify cắt ở ~100 bài: tải phần còn lại bằng Lavalink ở nền rồi nối vào hàng chờ (nếu player vẫn còn).
function appendRest(player, url, alreadyAdded, requester) {
  player
    .search({ query: url }, requester)
    .then((full) => {
      const rest = full.tracks.slice(alreadyAdded);
      if (rest.length && player.LavalinkManager.getPlayer(player.guildId) === player) return player.queue.add(rest);
    })
    .catch(() => {});
}

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

      // Playlist/album Spotify: lấy danh sách từ trang embed (nhanh), phát bài đầu ngay, các bài sau tìm dần khi tới lượt.
      const list = isUrl(query) ? await lazy.spotifyList(query) : null;
      let tracks, isPlaylist, title;
      if (list) {
        const found = await lazy.resolveHead(player, lazy.lazyTracks(player.LavalinkManager, list.tracks, i.user, source === "spsearch" ? "ytsearch" : source));
        [tracks, isPlaylist, title] = [found, true, list.name];
        if (list.truncated && found.length) appendRest(player, query, list.tracks.length, i.user);
      } else {
        const res = await player.search(isUrl(query) ? { query } : { query, source }, i.user);
        if (res.loadType !== "error" && res.loadType !== "empty") {
          isPlaylist = res.loadType === "playlist";
          tracks = isPlaylist ? res.tracks : res.tracks.slice(0, 1);
          title = res.playlist?.title;
        }
      }

      if (!tracks?.length) {
        if (created) await player.destroy("Không tìm thấy bài");
        return say(i, "❌ Không tìm thấy bài nào.");
      }
      if (i.options.getBoolean("next")) await player.queue.splice(0, 0, tracks);
      else await player.queue.add(tracks);
      await startIfIdle(player);

      return say(
        i,
        isPlaylist
          ? `📃 Đã thêm playlist **${title ?? "?"}** (${tracks.length} bài)`
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
      return i.reply({ embeds: [nowEmbed(player, track)], components: panelRows(player) });
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
      .setDescription("Bảng cài đặt: nguồn tìm nhạc, âm sắc, tốc độ, màu, thông báo..."),
    async run(i) {
      if (!isDJ(i.member)) return fail(i, "Lệnh này chỉ dành cho role DJ.");
      return i.reply({ ...settings.view(i.guildId), flags: MessageFlags.Ephemeral });
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
      // Bài đầu tìm ngay để phát liền, các bài sau chỉ giữ link và tìm khi tới lượt.
      const queued = await lazy.resolveHead(player, lazy.lazyTracks(player.LavalinkManager, saved, i.user));
      if (queued.length) {
        await player.queue.add(queued);
        await startIfIdle(player);
      }
      const added = queued.length;
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

// Nút (customId "m:...") dưới tin nhắn "Đang phát"
exports.panel = async (i) => {
  const player = await guard(i);
  if (!player) return;
  const action = i.customId.slice(2);
  const nextLoop = { off: "track", track: "queue", queue: "off" };
  const info = player.queue.current?.info;

  if (action === "back" || action === "fwd") {
    if (!(info?.isSeekable && !info.isStream)) return fail(i, "Bài này không tua được.");
    // tua quá cuối bài thì dừng lại ở 1s trước khi hết, không bỏ qua bài
    const step = action === "back" ? -SEEK_STEP_MS : SEEK_STEP_MS;
    await player.seek(Math.min(Math.max(0, player.position + step), info.duration - 1000));
  } else if (action === "pause") await (player.paused ? player.resume() : player.pause());
  else if (action === "loop") await player.setRepeatMode(nextLoop[player.repeatMode]);
  else if (action === "skip") await (player.queue.tracks.length ? player.skip() : player.stopPlaying(true, false));
  else if (action === "stop") {
    await (db.getSettings(i.guildId).always_on ? player.stopPlaying(true, false) : player.destroy("Nút dừng"));
  }

  const current = player.queue.current;
  if (current && ["pause", "loop", "back", "fwd"].includes(action)) {
    return i.update({ embeds: [nowEmbed(player, current)], components: panelRows(player) });
  }
  return i.deferUpdate();
};

exports.settingsPanel = settings.handle;
