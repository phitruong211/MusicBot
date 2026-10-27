// Lệnh chữ ("r!play <link hoặc tên bài>"): đọc tin nhắn, tách đối số theo định nghĩa của lệnh "/" rồi
// chạy đúng hàm run() của lệnh đó qua một đối tượng giả lập interaction, nên mọi lệnh đều dùng được cả hai kiểu.
const { EmbedBuilder } = require("discord.js");
const config = require("./config");

const STRING = 3, INTEGER = 4, BOOLEAN = 5, ROLE = 8, NUMBER = 10, SUBCOMMAND = 1;

const ALIASES = { p: "play", s: "skip", np: "nowplaying", q: "queue", vol: "volume", dc: "stop", leave: "stop" };

const defsCache = new Map();
const definition = (cmd) => {
  if (!defsCache.has(cmd)) defsCache.set(cmd, cmd.data.toJSON());
  return defsCache.get(cmd);
};

const usage = (def, sub) => {
  const args = (sub ?? def).options?.map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`)).join(" ");
  return `${config.prefix}${def.name}${sub ? ` ${sub.name}` : ""}${args ? ` ${args}` : ""}`;
};

// text: phần sau tên lệnh. Trả { sub, values: Map } hoặc { error }.
// Quy ước: tùy chọn chuỗi đầu tiên nhận hết phần còn lại ("r!play buồn của anh"), tùy chọn khác nhận một từ,
// tùy chọn đúng/sai và tùy chọn phụ truyền bằng cờ: "r!play lofi --source=scsearch --next".
exports.parse = (def, text, guild) => {
  let rest = text.trim();
  let sub = null;
  let opts = def.options ?? [];
  if (opts[0]?.type === SUBCOMMAND) {
    const [word, ...tail] = rest.split(/\s+/);
    sub = opts.find((o) => o.name === word.toLowerCase());
    if (!sub) return { error: `Dùng: ${opts.map((o) => usage(def, o)).join(" | ")}` };
    rest = tail.join(" ");
    opts = sub.options ?? [];
  }

  const raw = new Map();
  rest = rest
    .replace(/(?:^|\s)--([a-z]+)(?:=(\S+))?/gi, (_, key, val) => (raw.set(key.toLowerCase(), val ?? "true"), " "))
    .trim();
  let textTaken = false;
  for (const o of opts) {
    if (raw.has(o.name) || o.type === BOOLEAN || !rest) continue;
    if (o.type === STRING && !textTaken) {
      raw.set(o.name, rest);
      rest = "";
      textTaken = true;
    } else {
      const [word, ...tail] = rest.split(/\s+/);
      raw.set(o.name, word);
      rest = tail.join(" ");
    }
  }

  const values = new Map();
  for (const o of opts) {
    const v = raw.get(o.name);
    if (v === undefined) {
      if (o.required) return { error: `Thiếu \`${o.name}\`. Dùng: ${usage(def, sub)}` };
      continue;
    }
    if (o.type === BOOLEAN) values.set(o.name, /^(1|true|on|yes|bật)$/i.test(v));
    else if (o.type === INTEGER || o.type === NUMBER) {
      const n = Number(v);
      const ok = Number.isFinite(n) && (o.type === NUMBER || Number.isInteger(n)) && n >= (o.min_value ?? -Infinity) && n <= (o.max_value ?? Infinity);
      if (!ok) return { error: `\`${o.name}\` phải là số${o.min_value != null ? ` từ ${o.min_value} đến ${o.max_value}` : ""}. Dùng: ${usage(def, sub)}` };
      values.set(o.name, n);
    } else if (o.type === ROLE) {
      const role = guild.roles.cache.get(/\d{17,20}/.exec(v)?.[0]);
      if (!role) return { error: "Không tìm thấy role đó, hãy @mention role." };
      values.set(o.name, role);
    } else if (o.type === STRING) {
      if (o.choices) {
        const choice = o.choices.find((c) => c.value === v.toLowerCase() || c.name.toLowerCase() === v.toLowerCase());
        if (!choice) return { error: `\`${o.name}\` phải là: ${o.choices.map((c) => c.value).join(", ")}` };
        values.set(o.name, choice.value);
      } else if (o.max_length && v.length > o.max_length) return { error: `\`${o.name}\` tối đa ${o.max_length} ký tự.` };
      else values.set(o.name, v);
    }
  }
  return { sub: sub?.name, values };
};

// Đối tượng giả lập đủ phần của ChatInputCommandInteraction mà các lệnh đang dùng.
function interactionFor(message, def, { sub, values }) {
  let sent = null;
  // Tin nhắn thường không có kiểu "chỉ mình bạn thấy" nên bỏ cờ ephemeral.
  const body = ({ flags, ...v }) => ({ ...v, allowedMentions: { repliedUser: false } });
  const get = (name) => values.get(name) ?? null;
  const i = {
    commandName: def.name,
    client: message.client,
    guildId: message.guildId,
    channelId: message.channelId,
    member: message.member,
    user: message.author,
    deferred: false,
    replied: false,
    inGuild: () => true,
    options: { getString: get, getInteger: get, getNumber: get, getBoolean: get, getRole: get, getSubcommand: () => sub },
    async deferReply() {
      i.deferred = true;
      await message.channel.sendTyping().catch(() => {});
    },
    async reply(v) {
      i.replied = true;
      return (sent = await message.reply(body(typeof v === "string" ? { content: v } : v)));
    },
    async editReply(v) {
      i.replied = true;
      const b = body(typeof v === "string" ? { content: v } : v);
      return (sent = sent ? await sent.edit(b) : await message.reply(b));
    },
    followUp: (v) => message.channel.send(body(typeof v === "string" ? { content: v } : v)),
  };
  return i;
}

function help(message, commands) {
  const lines = commands.list.map((cmd) => {
    const def = definition(cmd);
    const forms = def.options?.[0]?.type === SUBCOMMAND ? def.options.map((s) => usage(def, s)) : [usage(def)];
    return `**${forms.join(" | ")}**\n${def.description}`;
  });
  const embed = new EmbedBuilder()
    .setColor(config.color)
    .setTitle("Danh sách lệnh")
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Viết tắt: ${Object.entries(ALIASES).map(([a, n]) => `${a}=${n}`).join(", ")} • Lệnh "/" vẫn dùng được` });
  return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
}

exports.handle = async (message, commands) => {
  const { prefix } = config;
  if (!prefix || message.author.bot || !message.inGuild()) return;
  if (!message.content.toLowerCase().startsWith(prefix.toLowerCase())) return;

  const m = /^(\S+)\s*([\s\S]*)$/.exec(message.content.slice(prefix.length).trim());
  if (!m) return;
  const name = ALIASES[m[1].toLowerCase()] ?? m[1].toLowerCase();
  if (name === "help") return help(message, commands);
  const cmd = commands.byName.get(name);
  if (!cmd) return; // lệnh lạ thì bỏ qua, tránh trả lời nhầm tin nhắn thường bắt đầu bằng "r!"

  const reply = (content) => message.reply({ content, allowedMentions: { repliedUser: false } }).catch(() => {});
  const def = definition(cmd);
  // Lệnh "/" giới hạn quyền ở phía Discord, lệnh chữ phải tự kiểm tra
  if (def.default_member_permissions && !message.member.permissions.has(BigInt(def.default_member_permissions))) {
    return void (await reply("❌ Bạn không có quyền dùng lệnh này."));
  }
  const parsed = exports.parse(def, m[2], message.guild);
  if (parsed.error) return void (await reply(`❌ ${parsed.error}`));

  try {
    await cmd.run(interactionFor(message, def, parsed));
  } catch (e) {
    console.error(`[${config.prefix}${name}]`, e);
    await reply("❌ Có lỗi xảy ra, thử lại sau.");
  }
};
