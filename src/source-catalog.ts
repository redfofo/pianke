export const sourceCatalog: readonly { id: string; title: string }[] = [
  { id: 'hongguo', title: '红果短剧' },
  { id: 'dsd', title: '帝果' },
  { id: '51chigua', title: '51吃瓜' },
  { id: 'huangdou', title: '黄豆' },
  { id: 'huangguo', title: '黄果短剧' },
  { id: 'huangju', title: '剧果' },
  { id: 'missav', title: 'MissAV' },
  { id: 'yeguo', title: '野果' },
];

export const sourceIds: readonly string[] = sourceCatalog.map((source) => source.id);
