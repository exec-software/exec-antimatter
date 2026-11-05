/** Turn a person's address-bar input into a web URL; never infer a privileged protocol. */
export function previewAddress(value: string): string {
  const address = value.trim();
  if (!address) throw new Error('Enter a website or local development server address.');
  if (address.length > 4096) throw new Error('This address is too long.');
  const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?=[:/?#]|$)/i.test(address);
  const bareHostWithPort = /^(?:[\w.-]+|\[[\da-f:]+\]):\d+(?:[/?#]|$)/i.test(address);
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(address) && !bareHostWithPort;
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? address : `${local || bareHostWithPort ? 'http' : 'https'}://${address}`);
  } catch {
    throw new Error('Enter a valid address, such as http://localhost:5173 or https://example.com.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Web preview only opens http and https addresses.');
  }
  if (parsed.username || parsed.password) throw new Error('Remove the username and password from the address.');
  if (!hasScheme && !local && !bareHostWithPort && !parsed.hostname.includes('.')) {
    throw new Error('Enter a full website address or a local server with its port.');
  }
  return parsed.toString();
}

export function previewFailureAdvice(url: string): string {
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '0.0.0.0' || host === '[::1]' || /^127\./.test(host)) {
      return 'Start the development server on this computer, check its port, then try again. For Electron projects, open the renderer’s development-server URL.';
    }
  } catch {
    // A failed IPC request may not have made it as far as URL validation.
  }
  return 'Check the address and your connection, or open this page in your browser. Preview uses a separate session and does not share browser logins.';
}
