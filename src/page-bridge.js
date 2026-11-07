'use strict';

const CHANNEL = 'comments';
// Local storage, not plugin data: data.json is shared through git, a theme is personal.
const THEME_KEY = 'claude-ide-bridge-page-theme';

// A page keeps its review database in <name>.comments.json next to it, and may
// read and write that one file and nothing else.
async function handlePageMessage(data, file, adapter, storage, respond) {
  if (!data || data.channel !== CHANNEL || data.reply) return;
  const reply = (result) => respond({ channel: CHANNEL, reply: true, reqId: data.reqId, ...result });
  const name = `${file.basename}.comments.json`;
  if (data.file !== name) {
    reply({ ok: false, error: `Only ${name} is accessible` });
    return;
  }
  const target = file.path.slice(0, -file.name.length) + name;
  try {
    if (data.op === 'ping') {
      reply({ ok: true, theme: storage.getItem(THEME_KEY) });
    } else if (data.op === 'theme' && (data.theme === 'light' || data.theme === 'dark')) {
      storage.setItem(THEME_KEY, data.theme);
      reply({ ok: true });
    } else if (data.op === 'read') {
      reply({ ok: true, content: (await adapter.exists(target)) ? await adapter.read(target) : null });
    } else if (data.op === 'write' && typeof data.content === 'string') {
      await adapter.write(target, data.content);
      reply({ ok: true });
    } else {
      reply({ ok: false, error: `Unsupported operation: ${data.op}` });
    }
  } catch (err) {
    reply({ ok: false, error: String((err && err.message) || err) });
  }
}

module.exports = { handlePageMessage };
