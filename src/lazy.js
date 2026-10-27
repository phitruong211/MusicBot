// Nạp playlist "lười": bài đầu được tìm ngay để phát liền, các bài sau chỉ giữ tên và
// được tìm khi sắp tới lượt (lavalink-client gọi resolve() lúc chuyển bài).

const SPOTIFY_LIST = /open\.spotify\.com\/(?:intl-[a-z]+\/)?(playlist|album)\/([A-Za-z0-9]+)/;
const EMBED_LIMIT = 100; // trang embed chỉ liệt kê tối đa ~100 bài

// Danh sách bài của playlist/album Spotify lấy từ trang embed công khai: 1 request ~0,5s,
// so với hơn 10s khi Lavalink tra từng bài. Trang này không phải API chính thức, lỗi thì trả null để dùng đường cũ.
exports.spotifyList = async (url) => {
  const m = SPOTIFY_LIST.exec(url);
  if (!m) return null;
  try {
    const res = await fetch(`https://open.spotify.com/embed/${m[1]}/${m[2]}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const json = /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s.exec(await res.text())?.[1];
    const entity = JSON.parse(json).props.pageProps.state.data.entity;
    const tracks = (entity.trackList ?? [])
      .filter((t) => t.title && t.isPlayable !== false)
      .map((t) => ({ title: t.title, author: t.subtitle, duration: t.duration }));
    return tracks.length ? { name: entity.name ?? entity.title, tracks, truncated: tracks.length >= EMBED_LIMIT } : null;
  } catch {
    return null;
  }
};

// items: [{ title, author?, duration?, uri? }]. Có uri thì resolve bằng uri, không thì tìm theo "tên + nghệ sĩ" ở `source`.
exports.lazyTracks = (lava, items, requester, source) =>
  items.map((item) => lava.utils.buildUnresolvedTrack({ ...item, sourceName: source }, requester));

// Resolve bài đầu (thử tối đa 3 bài nếu không tìm được) và trả về phần danh sách còn lại để thêm vào hàng chờ.
exports.resolveHead = async (player, tracks) => {
  for (let n = 0; n < Math.min(3, tracks.length); n++) {
    try {
      await tracks[n].resolve(player);
      return tracks.slice(n);
    } catch {
      // bài này không tìm được, thử bài kế
    }
  }
  return [];
};
