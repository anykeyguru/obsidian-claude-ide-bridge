'use strict';

function sandboxFrame(host, sandbox) {
  return host.createEl('iframe', { cls: 'cib-frame', attr: { sandbox, referrerpolicy: 'no-referrer' } });
}

module.exports = { sandboxFrame };
