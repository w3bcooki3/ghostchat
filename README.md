<div align="center">

<img src="icon.svg" width="76" alt="">

# Ghost Chat

**Say it once. Then it's gone.**

Private, end-to-end encrypted chat between two browsers.
No account, no app to install, nothing stored. Close the tab and it's gone.

[**Open Ghost Chat →**](https://w3bcooki3.github.io/ghostchat/)

[How it works](https://w3bcooki3.github.io/ghostchat/guide.html) · [Who can read what](https://w3bcooki3.github.io/ghostchat/security.html) · [Privacy & terms](https://w3bcooki3.github.io/ghostchat/legal.html)

</div>

---

## What it is

Ghost Chat is a one-to-one conversation that lives only in two browser tabs: yours and the person you invite. Messages and files are encrypted on your device before they leave it, and only the other person's browser can decrypt them. There are no accounts, no phone numbers, no contact lists and no message history on any server. When either of you closes the tab, the conversation and its keys are gone.

It works on phones and computers, on home Wi-Fi, mobile data, office networks and VPNs.

## How to use it

1. **Open Ghost Chat and tap _Start a private chat_.** You get a 20-character room code and an invite link.
2. **Send the link to one person**, over something you trust: in person, a phone call, or an app you already use. You can also show a QR code for someone next to you.
3. **They open the link and tap _Join_.** Your browsers check that both hold the same code, create fresh keys and connect. The room then **locks**: the code stops working, even for someone who has all 20 characters.
4. **Optional, but recommended for anything sensitive:** open *Session* and **compare the safety number** with the other person by voice. If both screens show the same 60 digits, nobody is in the middle.

That's it. Chat, send files, and close the tab when you're done.

> **Unused codes expire after 10 minutes** (you can extend to an hour). If a link says *"This room isn't open"*, the person who made it has left or ended the chat, so ask for a new invite.

## What you can do

**Talk**
- Messages with replies, reactions, edits (marked "edited") and delete for everyone or just for you.
- **Disappearing messages** from 10 seconds to 1 hour, set once for both of you.
- Delivered and read receipts and a typing indicator, each of which you can turn off.
- **Files up to 100 MB**, sent in encrypted pieces with a progress bar.

**Stay safe**
- **Panic wipe:** the red **Wipe** button (hold it on a phone) or <kbd>Esc</kbd> three times on a keyboard. Everything is destroyed instantly, the other person's session ends at once, and the page leaves.
- **Nothing opens by itself.** Photos are shown only when you tap **View**. Files are checked by their contents, not their name, and programs, scripts and disguised files (like `invoice.pdf.exe`) ask before saving.
- **Links show where they really go** before opening, and look-alike web addresses are flagged.
- **Maximum privacy** (on the home screen): hides your IP address from the other person and sends steady traffic so nobody watching the network can tell when you type.

**Make it yours**
- **Seven colour themes**: Signal, Phosphor, Aurora, Daylight, Graphite, Ledger and Vault, plus **Auto**, which is Signal by day and Phosphor by night. Your choice lasts for the tab and isn't saved anywhere.
- Pick a name and an avatar for the conversation. They're forgotten when you leave.

**Talk to someone else too**
- Each room is for exactly two people. To bring in a third, use **Invite** in the session panel. It opens a separate private room in a new tab.

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

**Can three people chat in one room?**
No. Each room's keys belong to one pair. Use *Invite* in the session panel to open a second room.

**It's stuck connecting. What now?**
If it says the other person *isn't answering*, their phone may be locked or the browser closed in the background. Ask them to open Ghost Chat again, then tap *Try again*. If the room *isn't open*, ask for a fresh invite. *Check my network* (under Privacy → Customize) explains what your network allows.

**Does it work with a VPN or on mobile data?**
Yes. If a direct connection can't be made, Ghost Chat switches to its relay over a normal secure web connection, which VPNs and phone networks allow.

**Can the other person see my IP address?**
On a direct connection, yes, as with any video call. Choose *Maximum privacy* before connecting to go through the relay instead.

**If I reload the page, can I get back in?**
No. Your keys live only in that tab. The person who created the room can let you back in once, and you'll get a new safety number to compare.

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
