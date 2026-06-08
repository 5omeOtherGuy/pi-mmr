import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const REDACTION_MODULE = "extensions/mmr-history/redaction.ts";

after(cleanupLoadedSource);

describe("mmr-history redaction — path family", () => {
  it("collapses ~/.pi/agent/sessions/<dir>/<file>.jsonl to [pi-session]", async () => {
    const { redactText, REDACTION_PI_SESSION } = await importSource(REDACTION_MODULE);
    const input = "open ~/.pi/agent/sessions/encoded-cwd/S-123.jsonl now";
    const out = redactText(input, { user: "" });
    assert.match(out, new RegExp(REDACTION_PI_SESSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(!out.includes("S-123.jsonl"));
    assert.ok(!out.includes("encoded-cwd"));
  });

  it("collapses other ~/.pi/... paths to [pi-data]", async () => {
    const { redactText, REDACTION_PI_DATA } = await importSource(REDACTION_MODULE);
    const out = redactText("Look in ~/.pi/agent/state/mode.json please", { user: "" });
    assert.ok(out.includes(REDACTION_PI_DATA));
    assert.ok(!out.includes("state/mode.json"));
  });

  it("replaces /home/<user> and /Users/<user> with [home] preserving the remainder", async () => {
    const { redactText, REDACTION_HOME } = await importSource(REDACTION_MODULE);
    const a = redactText("path is /home/alice/projects/foo/bar.ts here", { user: "" });
    assert.ok(a.includes(`${REDACTION_HOME}/projects/foo/bar.ts`));
    assert.ok(!a.includes("alice"));

    const b = redactText("path is /Users/bob/Code/app.js here", { user: "" });
    assert.ok(b.includes(`${REDACTION_HOME}/Code/app.js`));
    assert.ok(!b.includes("bob"));
  });

  it("replaces C:\\Users\\<user>\\... with [home]", async () => {
    const { redactText, REDACTION_HOME } = await importSource(REDACTION_MODULE);
    const out = redactText("see C:\\Users\\carol\\src\\app.ts done", { user: "" });
    assert.ok(out.includes(REDACTION_HOME));
    assert.ok(!out.includes("carol"));
  });

  it("reduces other absolute POSIX paths to [abs-path]/<basename>", async () => {
    const { redactText, REDACTION_ABS_PATH } = await importSource(REDACTION_MODULE);
    const out = redactText("tmp file at /var/tmp/build/output.log written", { user: "" });
    assert.ok(out.includes(`${REDACTION_ABS_PATH}/output.log`));
    assert.ok(!out.includes("/var/tmp/build/"));
  });

  it("does NOT redact relative paths", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const out = redactText("see src/index.ts and ./foo/bar.ts", { user: "" });
    assert.equal(out, "see src/index.ts and ./foo/bar.ts");
  });
});

describe("mmr-history redaction — secret family", () => {
  it("redacts Authorization Bearer headers but keeps the structure", async () => {
    const { redactText, REDACTION_REDACTED } = await importSource(REDACTION_MODULE);
    const out = redactText("Authorization: Bearer abc.def.ghi", { user: "" });
    assert.equal(out.includes(REDACTION_REDACTED), true);
    assert.ok(/Authorization:\s*Bearer\s*\[redacted\]/.test(out));
    assert.ok(!out.includes("abc.def.ghi"));
  });

  it("redacts Authorization Basic headers", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const out = redactText("authorization: Basic dXNlcjpwYXNzd2Q=", { user: "" });
    assert.ok(/authorization:\s*Basic\s*\[redacted\]/.test(out));
    assert.ok(!out.includes("dXNlcjpwYXNzd2Q="));
  });

  it("collapses JWT-shaped triples to [jwt]", async () => {
    const { redactText, REDACTION_JWT } = await importSource(REDACTION_MODULE);
    const jwt = "eyJhbGciOi.eyJzdWIiOj.SflKxwRJSM";
    const out = redactText(`token=${jwt} ok`, { user: "" });
    // The env-style key=value pattern owns the "token=" line, so the
    // JWT lives inside the [redacted] value. Either way the raw JWT
    // must not survive.
    assert.ok(!out.includes(jwt));
    const standalone = redactText(`see ${jwt} please`, { user: "" });
    assert.ok(standalone.includes(REDACTION_JWT));
  });

  it("does not match dotted version numbers as JWTs", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const out = redactText("ran version 1.2.3 today", { user: "" });
    assert.equal(out, "ran version 1.2.3 today");
  });

  it("collapses PEM private-key blocks to [pem]", async () => {
    const { redactText, REDACTION_PEM } = await importSource(REDACTION_MODULE);
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEAv8VXt...",
      "more=key=material=here",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redactText(`before\n${pem}\nafter`, { user: "" });
    assert.ok(out.includes(REDACTION_PEM));
    assert.ok(!out.includes("MIIEpAIBAAKCAQEA"));
    assert.ok(out.includes("before"));
    assert.ok(out.includes("after"));
  });

  it("redacts known provider tokens by prefix", async () => {
    const { redactText, REDACTION_TOKEN } = await importSource(REDACTION_MODULE);
    for (const raw of [
      "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAA",
      "sk-AAAAAAAAAAAAAAAAAAAAAAAA",
      "ghp_AAAAAAAAAAAAAAAAAAAAAAAA",
      "gho_AAAAAAAAAAAAAAAAAAAAAAAA",
      "AIzaAAAAAAAAAAAAAAAAAAAAAAA-AA",
      "jina_AAAAAAAAAAAAAAAAAAAA",
      "xoxb-1111111111-2222222222222",
      "xoxa-1111111111-2222222222222",
    ]) {
      const out = redactText(`KEY ${raw} END`, { user: "" });
      assert.ok(out.includes(REDACTION_TOKEN), `expected [token] for ${raw}: ${out}`);
      assert.ok(!out.includes(raw), `raw token must not survive: ${out}`);
    }
  });

  it("does NOT redact short token-like substrings", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const out = redactText("sk-short and ghp_short are not real keys", { user: "" });
    assert.equal(out, "sk-short and ghp_short are not real keys");
  });

  it("redacts env-style key=value pairs by key whitelist", async () => {
    const { redactText, REDACTION_REDACTED } = await importSource(REDACTION_MODULE);
    const out = redactText(
      "TOKEN=abc123 secret=hunter2 api_key=foo apiKey=bar password=baz cookie=zzz",
      { user: "" },
    );
    assert.ok(out.includes(`TOKEN=${REDACTION_REDACTED}`));
    assert.ok(out.includes(`secret=${REDACTION_REDACTED}`));
    assert.ok(out.includes(`api_key=${REDACTION_REDACTED}`));
    assert.ok(out.includes(`apiKey=${REDACTION_REDACTED}`));
    assert.ok(out.includes(`password=${REDACTION_REDACTED}`));
    assert.ok(out.includes(`cookie=${REDACTION_REDACTED}`));
    assert.ok(!out.includes("hunter2"));
    assert.ok(!out.includes("abc123"));
  });

  it("does NOT redact unrelated key=value forms", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const out = redactText("mode=smart and tier=large", { user: "" });
    assert.equal(out, "mode=smart and tier=large");
  });

  it("strips URL userinfo while preserving scheme and host", async () => {
    const { redactText, REDACTION_REDACTED } = await importSource(REDACTION_MODULE);
    const out = redactText("clone https://alice:t0p@github.com/owner/repo here", { user: "" });
    assert.ok(out.includes(`https://${REDACTION_REDACTED}@github.com/owner/repo`));
    assert.ok(!out.includes("alice:t0p"));
    assert.ok(!out.includes("t0p@"));
  });
});

describe("mmr-history redaction — identity family", () => {
  it("redacts the OS username when supplied via opts.user", async () => {
    const { redactText, REDACTION_USER } = await importSource(REDACTION_MODULE);
    const out = redactText("Hello alice, /home/alice/x.ts and bare alice again", { user: "alice" });
    // The /home/<user> rule swallows the first occurrence; the bare
    // form is what the identity pass is for.
    assert.ok(out.includes(REDACTION_USER));
    assert.ok(!/\balice\b/.test(out));
  });

  it("ignores a too-short user value to avoid false positives", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const out = redactText("a or A everywhere", { user: "a" });
    assert.equal(out, "a or A everywhere");
  });

  it("uses os.userInfo() by default when no opts.user is provided", async () => {
    const { redactText, __resetRedactionUsernameCacheForTests } = await importSource(REDACTION_MODULE);
    __resetRedactionUsernameCacheForTests();
    const { userInfo } = await import("node:os");
    const realUser = userInfo().username;
    if (!realUser || realUser.length < 2) {
      return; // CI environments may have unusual user info; skip.
    }
    const out = redactText(`hello ${realUser} world`);
    assert.ok(!new RegExp(`\\b${realUser}\\b`).test(out), `username must be redacted: ${out}`);
  });
});

describe("mmr-history redaction — idempotence", () => {
  it("running redactText twice produces the same output", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const fixtures = [
      "Plain message with no secrets",
      "see /home/alice/projects/foo/bar.ts and src/x.ts",
      "Authorization: Bearer abc.def.ghi",
      "token=hunter2 password=hunter3",
      "https://alice:secret@example.com/path",
      "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAA end",
      "open ~/.pi/agent/sessions/cwd/S-1.jsonl",
      "-----BEGIN RSA PRIVATE KEY-----\nABCDEF\n-----END RSA PRIVATE KEY-----",
      "JWT eyJhbGciOi.eyJzdWIiOj.SflKxwRJSM here",
      "abs /var/log/syslog tail",
      "C:\\Users\\carol\\app.ts",
    ];
    for (const fixture of fixtures) {
      const once = redactText(fixture, { user: "alice" });
      const twice = redactText(once, { user: "alice" });
      assert.equal(twice, once, `not idempotent for: ${fixture}\n once=${once}\n twice=${twice}`);
    }
  });
});

describe("mmr-history redaction — authorization env/CLI form", () => {
  it("redacts a bare authorization=<value> env form", async () => {
    const { redactText, REDACTION_REDACTED } = await importSource(REDACTION_MODULE);
    const out = redactText("authorization=plain-secret here", { user: "" });
    assert.ok(out.includes(`authorization=${REDACTION_REDACTED}`));
    assert.ok(!out.includes("plain-secret"));
  });

  it("redacts authorization=<value> in CLI flag form while preserving the key", async () => {
    const { redactText, REDACTION_REDACTED } = await importSource(REDACTION_MODULE);
    const out = redactText("--authorization=Bearer abc-123", { user: "" });
    assert.ok(out.includes(`--authorization=Bearer ${REDACTION_REDACTED}`));
    assert.ok(!out.includes("abc-123"));
  });

  it("is case-insensitive on the key", async () => {
    const { redactText, REDACTION_REDACTED } = await importSource(REDACTION_MODULE);
    const out = redactText("AUTHORIZATION=secretValue", { user: "" });
    assert.ok(out.includes(`AUTHORIZATION=${REDACTION_REDACTED}`));
    assert.ok(!out.includes("secretValue"));
  });

  it("leaves the AUTH_HEADER form's redacted output intact (header form still wins)", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const out = redactText("Authorization: Bearer abc.def.ghi", { user: "" });
    assert.ok(/Authorization:\s*Bearer\s*\[redacted\]/.test(out));
    assert.ok(!out.includes("abc.def.ghi"));
    // The Bearer keyword must survive the AUTH_KV pass that runs
    // after AUTH_HEADER, otherwise the header structure is lost.
    assert.ok(out.includes("Bearer"));
  });

  it("is idempotent across env/CLI forms", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const inputs = [
      "authorization=plain-secret",
      "--authorization=Bearer abc-123",
      "AUTHORIZATION=secretValue",
      "Authorization: Bearer abc.def.ghi",
      "authorization: Basic dXNlcjpwYXNz",
    ];
    for (const input of inputs) {
      const once = redactText(input, { user: "" });
      const twice = redactText(once, { user: "" });
      assert.equal(twice, once, `not idempotent for: ${input}\n once=${once}\n twice=${twice}`);
    }
  });
});

describe("mmr-history redaction — quoted KV values", () => {
  it("redacts JSON-style quoted key/value containing spaces", async () => {
    const { redactText, REDACTION_REDACTED } = await importSource(REDACTION_MODULE);
    const out = redactText('{"api_key": "foo bar baz"}', { user: "" });
    assert.ok(out.includes(`"api_key": "${REDACTION_REDACTED}"`));
    assert.ok(!out.includes("foo bar baz"));
  });

  it("redacts single-quoted values containing spaces", async () => {
    const { redactText, REDACTION_REDACTED } = await importSource(REDACTION_MODULE);
    const out = redactText("api_key='foo bar baz'", { user: "" });
    assert.ok(out.includes(`api_key='${REDACTION_REDACTED}'`));
    assert.ok(!out.includes("foo bar baz"));
  });

  it("handles escaped double-quotes inside JSON values", async () => {
    const { redactText, REDACTION_REDACTED } = await importSource(REDACTION_MODULE);
    const out = redactText('{"secret": "ab\\"cd"}', { user: "" });
    assert.ok(out.includes(`"secret": "${REDACTION_REDACTED}"`));
    assert.ok(!out.includes('ab\\"cd'));
  });

  it("handles escaped single-quotes inside single-quoted values", async () => {
    const { redactText, REDACTION_REDACTED } = await importSource(REDACTION_MODULE);
    const out = redactText("token='ab\\'cd'", { user: "" });
    assert.ok(out.includes(`token='${REDACTION_REDACTED}'`));
    assert.ok(!out.includes("ab\\'cd"));
  });

  it("is idempotent for each quoted form", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const inputs = [
      '{"api_key": "foo bar"}',
      "api_key='foo bar'",
      'cookie="zzz"',
      "TOKEN=plain",
      '{"secret": "ab\\"cd"}',
    ];
    for (const input of inputs) {
      const once = redactText(input, { user: "" });
      const twice = redactText(once, { user: "" });
      assert.equal(twice, once, `not idempotent for: ${input}\n once=${once}\n twice=${twice}`);
    }
  });
});

describe("mmr-history redaction — AWS access keys", () => {
  it("redacts AKIA-prefixed access key IDs", async () => {
    const { redactText, REDACTION_TOKEN } = await importSource(REDACTION_MODULE);
    const out = redactText("see AKIAIOSFODNN7EXAMPLE here", { user: "" });
    assert.ok(out.includes(REDACTION_TOKEN));
    assert.ok(!out.includes("AKIAIOSFODNN7EXAMPLE"));
  });

  it("does NOT redact short AKIA-prefixed strings", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const out = redactText("AKIA-short is too short", { user: "" });
    assert.equal(out, "AKIA-short is too short");
  });

  it("is idempotent for AWS keys", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const once = redactText("AKIAIOSFODNN7EXAMPLE end", { user: "" });
    assert.equal(redactText(once, { user: "" }), once);
  });
});

describe("mmr-history redaction — Slack webhooks", () => {
  it("redacts Slack incoming-webhook URLs to [token]", async () => {
    const { redactText, REDACTION_TOKEN } = await importSource(REDACTION_MODULE);
    const out = redactText(
      "post to https://hooks.slack.com/services/T00000000/B00000000/abcXYZsecret now",
      { user: "" },
    );
    assert.ok(out.includes(REDACTION_TOKEN));
    assert.equal(out.split("hooks.slack.com").length, 1);
    assert.ok(!out.includes("abcXYZsecret"));
  });

  it("is idempotent for Slack webhooks", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const input = "see https://hooks.slack.com/services/T00/B00/abcXYZ end";
    const once = redactText(input, { user: "" });
    assert.equal(redactText(once, { user: "" }), once);
  });
});

describe("mmr-history redaction — email addresses", () => {
  it("collapses email addresses to [email]", async () => {
    const { redactText, REDACTION_EMAIL } = await importSource(REDACTION_MODULE);
    const out = redactText("contact alice@example.com today", { user: "" });
    assert.ok(out.includes(REDACTION_EMAIL));
    assert.ok(!out.includes("alice@example.com"));
  });

  it("handles plus-tagged local parts and multi-label domains", async () => {
    const { redactText, REDACTION_EMAIL } = await importSource(REDACTION_MODULE);
    const out = redactText("send to bob+tag@sub.example.co.uk now", { user: "" });
    assert.ok(out.includes(REDACTION_EMAIL));
    assert.ok(!out.includes("bob+tag"));
    assert.equal(out.split("sub.example.co.uk").length, 1);
  });

  it("does NOT eat the URL_USERINFO [redacted] marker", async () => {
    const { redactText, REDACTION_REDACTED } = await importSource(REDACTION_MODULE);
    const out = redactText("clone https://alice:t0p@github.com/owner/repo here", { user: "" });
    assert.ok(out.includes(`${REDACTION_REDACTED}@github.com`));
    assert.ok(!out.includes("[email]@github.com"));
  });

  it("is idempotent for emails", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const once = redactText("reach alice@example.com or bob+tag@sub.example.co.uk", { user: "" });
    assert.equal(redactText(once, { user: "" }), once);
  });
});

describe("mmr-history redaction — IPv4 / IPv6 addresses", () => {
  it("redacts canonical IPv4 addresses to [ip]", async () => {
    const { redactText, REDACTION_IP } = await importSource(REDACTION_MODULE);
    const out = redactText("server at 192.168.1.1 listening", { user: "" });
    assert.ok(out.includes(REDACTION_IP));
    assert.ok(!out.includes("192.168.1.1"));
  });

  it("redacts public IPv4 addresses", async () => {
    const { redactText, REDACTION_IP } = await importSource(REDACTION_MODULE);
    const out = redactText("ping 8.8.8.8 ok", { user: "" });
    assert.ok(out.includes(REDACTION_IP));
    assert.ok(!out.includes("8.8.8.8"));
  });

  it("does NOT redact 3-octet version-style strings", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const out = redactText("version 1.2.3 today", { user: "" });
    assert.equal(out, "version 1.2.3 today");
  });

  it("redacts full IPv6 addresses", async () => {
    const { redactText, REDACTION_IP } = await importSource(REDACTION_MODULE);
    const out = redactText(
      "addr 2001:0db8:85a3:0000:0000:8a2e:0370:7334 here",
      { user: "" },
    );
    assert.ok(out.includes(REDACTION_IP));
    assert.ok(!out.includes("2001:0db8:85a3"));
  });

  it("redacts IPv6 loopback ::1 and unspecified :: addresses", async () => {
    const { redactText, REDACTION_IP } = await importSource(REDACTION_MODULE);
    const a = redactText("listen on ::1 port", { user: "" });
    assert.ok(a.includes(REDACTION_IP));
    assert.ok(!a.includes("::1"));
    const b = redactText("bind :: please", { user: "" });
    assert.ok(b.includes(REDACTION_IP));
  });

  it("redacts IPv6 link-local fe80::... addresses", async () => {
    const { redactText, REDACTION_IP } = await importSource(REDACTION_MODULE);
    const out = redactText("link fe80::1ff:fe23:4567:890a yes", { user: "" });
    assert.ok(out.includes(REDACTION_IP));
    assert.ok(!out.includes("fe80::1ff"));
  });

  it("does NOT redact :: when adjacent to identifier characters", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const out = redactText("std::cout and Module::method", { user: "" });
    assert.equal(out, "std::cout and Module::method");
  });

  it("redacts compressed public / unique-local IPv6 addresses", async () => {
    const { redactText, REDACTION_IP } = await importSource(REDACTION_MODULE);
    for (const [input, leak] of [
      ["node 2001:db8::1 up", "2001:db8"],
      ["dns 2001:4860:4860::8888 ok", "4860"],
      ["ula fd00::1234 here", "fd00"],
      ["mixed 2001:db8:0:0:0:0:2:1 end", "2001:db8"],
    ]) {
      const out = redactText(input, { user: "" });
      assert.ok(out.includes(REDACTION_IP), `expected [ip] in: ${input} -> ${out}`);
      assert.ok(!out.includes(leak), `leaked ${leak} in: ${out}`);
    }
  });

  it("redacts IPv4-mapped IPv6 as a single [ip] with no leaked hextets", async () => {
    const { redactText, REDACTION_IP } = await importSource(REDACTION_MODULE);
    const out = redactText("peer ::ffff:192.168.1.1 seen", { user: "" });
    assert.equal(out, `peer ${REDACTION_IP} seen`);
    assert.ok(!out.includes("ffff"));
    assert.ok(!out.includes("192.168"));
  });

  it("redacts zoned IPv6 including the %zone suffix", async () => {
    const { redactText, REDACTION_IP } = await importSource(REDACTION_MODULE);
    const out = redactText("bind 2001:db8::1%eth0 now", { user: "" });
    assert.ok(out.includes(REDACTION_IP));
    assert.ok(!out.includes("2001:db8"));
    assert.ok(!out.includes("%eth0"));
  });

  it("redacts an IPv6 address embedded in prose without eating words", async () => {
    const { redactText, REDACTION_IP } = await importSource(REDACTION_MODULE);
    const out = redactText("connect to 2001:db8::1 now", { user: "" });
    assert.equal(out, `connect to ${REDACTION_IP} now`);
  });

  it("does NOT redact language :: syntax or non-address colon text", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    for (const s of [
      "std::cout and Module::method",
      "Foo::Bar::baz",
      "hex word cafe and dead",
      "time 12:34 today",
      "mac-ish de:ad:be:ef list",
    ]) {
      assert.equal(redactText(s, { user: "" }), s, `unexpected redaction of: ${s}`);
    }
  });

  it("redacts bare single-group IPv6 literals (over-redaction over namespace lookalikes)", async () => {
    const { redactText, REDACTION_IP } = await importSource(REDACTION_MODULE);
    // `x::y` is a valid IPv6 literal (isIP === 6). The redactor's
    // over-redaction stance redacts it rather than leak a routable
    // address, and keeps `0::1` consistent with `::1`.
    assert.equal(redactText("a::b", { user: "" }), REDACTION_IP);
    assert.equal(redactText("0::1", { user: "" }), REDACTION_IP);
    assert.equal(redactText("host 1::2 here", { user: "" }), `host ${REDACTION_IP} here`);
    assert.equal(redactText("loop 0::1 vs ::1", { user: "" }), `loop ${REDACTION_IP} vs ${REDACTION_IP}`);
  });

  it("is idempotent for IP addresses", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const inputs = [
      "192.168.1.1",
      "see ::1 here",
      "link fe80::1ff:fe23:4567:890a",
      "v6 2001:0db8:85a3:0000:0000:8a2e:0370:7334",
      "bind :: please",
      "compressed 2001:db8::1 done",
      "mapped ::ffff:192.168.1.1 done",
      "zoned 2001:db8::1%eth0 done",
      "single a::b done",
      "loop 0::1 done",
    ];
    for (const input of inputs) {
      const once = redactText(input, { user: "" });
      const twice = redactText(once, { user: "" });
      assert.equal(twice, once, `not idempotent for: ${input}\n once=${once}\n twice=${twice}`);
    }
  });
});

describe("mmr-history redaction — JWT trade-offs", () => {
  it("does NOT redact very short JWT-like triples (under 8 chars per segment)", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const out = redactText("compact a.b.c form", { user: "" });
    assert.equal(out, "compact a.b.c form");
  });

  it("redacts dotted hash-like strings as [jwt] (accepted over-redaction)", async () => {
    const { redactText, REDACTION_JWT } = await importSource(REDACTION_MODULE);
    const out = redactText("hash a1b2c3d4.e5f6g7h8.deadbeef here", { user: "" });
    assert.ok(out.includes(REDACTION_JWT));
    assert.ok(!out.includes("a1b2c3d4"));
  });
});

describe("mmr-history redaction — combined new categories", () => {
  it("redactText is idempotent on a fixture mixing every new category", async () => {
    const { redactText } = await importSource(REDACTION_MODULE);
    const fixture = [
      "Authorization: Bearer abc.def.ghi",
      "authorization=plain-secret",
      "--authorization=Bearer xyz-token",
      'JSON {"api_key": "foo bar baz"}',
      "single secret='hush hush'",
      "AWS AKIAIOSFODNN7EXAMPLE here",
      "slack https://hooks.slack.com/services/T00/B00/abcXYZ",
      "email bob+tag@sub.example.co.uk",
      "ipv4 192.168.1.1 and 10.0.0.255",
      "ipv6 full 2001:0db8:85a3:0000:0000:8a2e:0370:7334",
      "ipv6 loop ::1",
      "ipv6 link fe80::1ff:fe23:4567:890a",
      "jwt-shaped a1b2c3d4.e5f6g7h8.deadbeef",
      "path /home/alice/projects/foo/bar.ts",
      "url https://alice:t0p@github.com/owner/repo",
    ].join("\n");
    const once = redactText(fixture, { user: "alice" });
    const twice = redactText(once, { user: "alice" });
    assert.equal(twice, once, `idempotence failed:\n once=${once}\n twice=${twice}`);
  });
});

describe("mmr-history redaction — projectRefFromCwd", () => {
  it("returns a deterministic 8-char hex string", async () => {
    const { projectRefFromCwd, PROJECT_REF_HEX_LENGTH } = await importSource(REDACTION_MODULE);
    const a = projectRefFromCwd("/home/alice/projects/foo");
    const b = projectRefFromCwd("/home/alice/projects/foo");
    assert.equal(a, b);
    assert.equal(a.length, PROJECT_REF_HEX_LENGTH);
    assert.match(a, /^[0-9a-f]{8}$/);
  });

  it("returns different refs for different cwds", async () => {
    const { projectRefFromCwd } = await importSource(REDACTION_MODULE);
    const a = projectRefFromCwd("/repo/one");
    const b = projectRefFromCwd("/repo/two");
    assert.notEqual(a, b);
  });

  it("normalizes trailing slashes and backslashes consistently", async () => {
    const { projectRefFromCwd } = await importSource(REDACTION_MODULE);
    assert.equal(projectRefFromCwd("/repo/one/"), projectRefFromCwd("/repo/one"));
    assert.equal(projectRefFromCwd("C:\\repo\\one"), projectRefFromCwd("C:/repo/one"));
  });
});
