# Comms and Email connections

Enable Comms or Email in Settings → Plugins before adding accounts. Connections
are off by default. Credentials and registration secrets use the operating-system
keyring; an unlocked keyring is required. Removing an account removes its local
credentials and project grants. Revoke the application at your provider as well
when you want to revoke its remote authorization.

## Set up a provider

- **Discord:** provide a bot token and server ID from your Discord application.
  Give the bot access to the intended channels and enable the Message Content
  intent when required. This is a bot integration, not a personal-user token.
  See [Discord's application and gateway permissions](https://docs.discord.com/developers/events/gateway#message-content-intent).
- **Slack:** provide an authorized token, or configure your Slack app's client ID,
  client secret, and registered HTTPS callback URL. The browser flow requests bot
  scopes for channel lists, history, direct messages, and sending. It only sees
  conversations available to that token. Paste the complete redirected callback
  URL into Antimatter to finish. Configure and review scopes in
  [Slack's OAuth documentation](https://docs.slack.dev/authentication/installing-with-oauth/).
- **Microsoft Outlook and Teams:** configure your application's client ID, tenant
  (`common`, `organizations`, `consumers`, or a tenant GUID), and registered desktop
  loopback URL such as `http://127.0.0.1:47831/callback`. Browser sign-in returns to
  the local listener and uses PKCE. Outlook requests `Mail.Read`, `Mail.Send`, and
  offline access; Teams requests `Chat.Read`, `ChatMessage.Send`, and offline access.
  Tenant administrators can require consent. See Microsoft's
  [authorization code and PKCE flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).
- **Gmail:** configure a Google OAuth client, the client secret if required by that
  client type, and its registered loopback URL. Enter the mailbox address used for
  sending. Gmail requests read-only mail and send scopes, with offline refresh and
  PKCE. Your Google consent configuration must allow each tester; Gmail scopes may
  require verification before broad distribution. See Google's
  [installed application OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app).
- **Yahoo Mail:** use a Yahoo app password, or configure an approved Yahoo developer
  application with the client ID, client secret, and registered HTTPS callback.
  The OAuth flow requests mail read/write scopes. Paste the complete callback URL
  to finish. Mail uses TLS on Yahoo's IMAP and SMTP endpoints. See
  [Yahoo's mail developer requirements](https://senders.yahooinc.com/developer/documentation/).

Provider registrations are not included in the release. Accounts remain disconnected
until you supply credentials or configure and complete sign-in. Hosted HTTPS callback
URLs for Slack and Yahoo must belong to the person or organization registering the
app. Antimatter does not create a callback website or transmit a callback to an
unrelated service.

## Read and send

Readers display text only. HTML is converted to text; remote images, attachments,
scripts, and embedded content are not opened. Lists are paginated. HTTP responses
are capped at 2 MiB, displayed message text at 65,536 characters, and Yahoo MIME downloads at
1 MiB. Yahoo scans at most 1,000 UIDs per page; a sparse mailbox may require another
Load more even when a page contains no messages. Slack thread previews show at most
15 replies and indicate when more exist in Slack.

Compose a message, review its destination and text, then send it. Outlook replies
use the provider's reply endpoint. Gmail replies include the original API thread
ID and MIME reply headers. Teams currently supports new chat messages; threaded
chat replies are unavailable. Discord sends disable automatic mention parsing.
Slack sends disable link/media previews.

Each send has a persistent request ID. If the provider may have accepted a message
but its response was lost, Antimatter records an **uncertain** receipt and does not
retry automatically. Check the provider's sent history before composing a new send.
This avoids duplicate messages after network failures or restarts.
The local receipt ledger holds up to 10,000 sends. At that limit, new sends stop
instead of forgetting receipts and risking duplicates.

Drafts are saved in the private desktop profile as you edit, with up to 50 drafts and
a 4 MiB storage limit. A draft locks before its send request starts and stays locked
after reopening if delivery is unconfirmed. **Check delivery** reads Antimatter's
saved receipt without contacting the provider or sending again. A confirmed receipt
removes the draft; an absent receipt unlocks it for another review. An uncertain
receipt keeps it locked, so check the provider's own history before starting a new
message. If saved drafts cannot be read, download a recovery copy and explicitly
reset draft storage. The application does not silently replace unreadable drafts.

## Agent access

Human account access and agent permissions are separate. For each workspace, grant
read and send access independently; both are off initially. An agent only discovers
accounts granted to its current workspace. Disabling the plugin or removing the
account blocks further requests. Connected messages remain external content and
should not be treated as instructions to reveal credentials or change permissions.
