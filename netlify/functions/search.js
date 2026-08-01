const stations = require("../../vedur-stations.json");

exports.handler = async (event) => {
  const q = (event.queryStringParameters?.q || "").trim().toLowerCase();
  if (!q) return json({ matches: [] });

  const starts = stations.filter((s) => s.name.toLowerCase().startsWith(q));
  const startsSet = new Set(starts);
  const contains = stations.filter((s) => !startsSet.has(s) && s.name.toLowerCase().includes(q));
  const matches = [...starts, ...contains].slice(0, 8);

  return json({ matches });
};

function json(obj, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}
