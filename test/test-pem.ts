// A real key, so createAppJwt and importPrivateKey run rather than being stubbed around.
let pemPromise: Promise<string> | null = null;
export function testPem(): Promise<string> {
  pemPromise ??= (async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const der = new Uint8Array(
      (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
    );
    let binary = "";
    for (const byte of der) binary += String.fromCharCode(byte);
    return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
  })();
  return pemPromise;
}
