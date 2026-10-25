<div align="center">

<img src="icon.svg" width="76" alt="">

# Ghost Chat

**Say it once. Then it's gone.**

Private, end-to-end encrypted chat between browsers, for two to six people.
No account, no app to install, nothing stored. Close the tab and it's gone.

[**Open Ghost Chat →**](https://w3bcooki3.github.io/ghostchat/)

[How it works](https://w3bcooki3.github.io/ghostchat/guide.html) · [Who can read what](https://w3bcooki3.github.io/ghostchat/security.html) · [Privacy & terms](https://w3bcooki3.github.io/ghostchat/legal.html)

</div>

---

## What it is

Ghost Chat is a conversation that lives only in browser tabs: yours and those of the people you let in (up to six in a room). Messages and files are encrypted on your device before they leave it, and only the recipients' browsers can decrypt them. There are no accounts, no phone numbers, no contact lists and no message history on any server. When you close the tab, your copy of the conversation and its keys are gone.

It works on phones and computers, on home Wi-Fi, mobile data, office networks and VPNs.

## How to use it

1. **Open Ghost Chat and tap _Start a private chat_.** You get a 20-character room code and an invite link.
2. **Send the link to one person**, over something you trust: in person, a phone call, or an app you already use. You can also show a QR code for someone next to you.
3. **They open the link and tap _Join_.** Your browsers check that both hold the same code, create fresh keys and connect. Anyone else who uses the code afterwards has to **wait for you to let them in**.
4. **Optional, but recommended for anything sensitive:** open *Session* and **compare the safety number** with the other person by voice. If both screens show the same 60 digits, nobody is in the middle.

That's it. Chat, send files, and close the tab when you're done.

> **Unused codes expire after 10 minutes** (you can extend to an hour). If a link says *"This room isn't open"*, the person who made it has left or ended the chat, so ask for a new invite.

## What you can do

**Talk**
- Messages with replies, reactions, edits (marked "edited") and delete for everyone or just for you.
- **Disappearing messages** from 10 seconds to 1 hour, set once for everyone in the room.
- **Unsend all mine** removes everything you sent from every screen. The host can also **clear the chat for everyone**.
- Delivered and read receipts and a typing indicator, each of which you can turn off.
- **Files up to 100 MB**, sent in encrypted pieces with a progress bar.

**Stay safe**
- **Panic wipe:** the red **Wipe** button (hold it on a phone) or <kbd>Esc</kbd> three times on a keyboard. Everything is destroyed instantly, the other person's session ends at once, and the page leaves.
- **Nothing opens by itself.** Photos are shown only when you tap **View**. Files are checked by their contents, not their name, and programs, scripts and disguised files (like `invoice.pdf.exe`) ask before saving.
- **Links show where they really go** before opening, and look-alike web addresses are flagged.
- **Maximum privacy** (on the home screen): hides your IP address from the other person and sends steady traffic so nobody watching the network can tell when you type.

**Make it yours**
- **Ten colour themes**: Signal, Phosphor, Aurora, Daylight, Graphite, Ledger, Vault, Apple, Haven and Telegram, plus **Auto**, which is Signal by day and Phosphor by night. Messages show as **bubbles** or as **lines** (a left-aligned log), and the live strip of encrypted bytes can be hidden. Your choices last for the tab and aren't saved anywhere.
- **A three-column room on wide screens**: the room code, the people here and how you're connected on the left; the conversation in the middle; details (safety numbers, privacy, theme, keys) on the right. On phones both side columns slide in as sheets.
- Pick a name and an avatar for the conversation. They're forgotten when you leave.

**Group rooms**
- **Up to 6 people per room.** Tap **Invite someone** in the room panel (or **Invite** under Details) for the same link, a QR code or the code. The first person you invite joins straight away. After that, everyone who uses the code shows up as *"wants to join"*, and the host taps **Let in** or **Deny**.
- **Every pair of people gets its own encryption** and its own safety number, so messages between two people are readable only by them. Compare your number with each person.
- **The host is in charge.** Only the host can share the invite, unless they switch on *Members can invite*. The host can also **remove** anyone.

## How private is it?

**What's protected:** the content of everything you send (messages, files, names, reactions, read receipts and typing) is end-to-end encrypted. Ghost Chat uses a hybrid key exchange (ECDH P-384 plus ML-KEM-1024, a post-quantum algorithm standardised by NIST), so recordings made today stay safe even against future quantum computers. Every single message gets its own AES-256 key, used once and thrown away. Any message that has been altered, replayed or reordered closes the conversation instead of being shown.

**What the servers see:** Ghost Chat needs two helpers to connect browsers across the internet.
- An **introduction server** sees your IP address and a short room name.
- When a direct connection is impossible, a **relay** passes along sealed packets it can't open.

Neither ever sees your messages, your keys or the full room code. The [Who can read what](https://w3bcooki3.github.io/ghostchat/security.html) page lets you look through each party's eyes.

**What no app can protect against:**
- **A compromised device.** Malware or a screen recorder sees what you see.
- **The other person.** They can screenshot or copy anything you send.
- **A code that leaks before your contact joins.** Whoever has it could get in first. Comparing safety numbers catches this.
- **That you're talking at all.** Networks can see that two devices are connected, and when.

**What's stored:** nothing. There are no cookies, no local storage and no message history, on the server or in your browser. The [privacy policy](https://w3bcooki3.github.io/ghostchat/legal.html) has the details.

## Questions

**Do I need an account or an app?**
No. Any current browser works: Chrome, Safari, Firefox or Edge, on a phone or a computer.

**Can more than two people chat?**
Yes, up to six. Use *Invite someone* in the room panel. The host lets each newcomer in, and every pair of people gets its own keys and safety number.

**It's stuck connecting. What now?**
If it says the other person *isn't answering*, their phone may be locked or the browser closed in the background. Ask them to open Ghost Chat again, then tap *Try again*. If the room *isn't open*, ask for a fresh invite. *Check my network* (under Privacy → Customize) explains what your network allows.

**Does it work with a VPN or on mobile data?**
Yes. If a direct connection can't be made, Ghost Chat switches to its relay over a normal secure web connection, which VPNs and phone networks allow.

**Can the other person see my IP address?**
On a direct connection, yes, as with any video call. Choose *Maximum privacy* before connecting to go through the relay instead.

**If I reload the page, can I get back in?**
Yes, as a newcomer. Your old keys lived only in that tab, so open the invite again and ask to join. The host lets you back in, and you'll get a new safety number to compare.

**Is it "military grade"?**
Nobody certifies apps as military grade. Ghost Chat uses the same algorithms and key sizes as the US government's CNSA 2.0 suite, but it isn't certified or independently audited, and a website isn't a classified environment.

## Honest status

Ghost Chat has had internal security reviews ([review history](docs/AUDIT.md)) and is covered by automated tests that run real browsers, but it has **not been independently audited**. It's a good tool for private conversations with people you trust. If your safety depends on it, use [Signal](https://signal.org).

**Found a security problem?** Please report it privately through a security advisory on this repository, not a public issue.

## More

- [How it works](https://w3bcooki3.github.io/ghostchat/guide.html): the technology, with diagrams.
- [Who can read what](https://w3bcooki3.github.io/ghostchat/security.html): an interactive look through each party's eyes.
- [Security model](SECURITY.md): the full protocol specification.
- [The relay](relay/README.md): what it is and what it can see.
- [Running your own copy](docs/DEVELOPING.md): for developers and self-hosters.

Ghost Chat is free and open source under the [MIT License](LICENSE).
