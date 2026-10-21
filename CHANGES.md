# Changes

Changes up to and including 0.4.1 are recorded in FediPod's
[CHANGES.md](https://github.com/jeff-zucker/FediPod/blob/main/CHANGES.md),
under the headings that name fedipod-bb.

## 2026-10-21 (forum pages arrive drawn — version 0.5.0)

**At a forum's own host, the front page, each category and each topic arrive
with their words already on them**, where the Gateway keeps the forum. A
reader no longer waits on "Loading…" while their browser fetches each post
one after another, and a reader without JavaScript can read every public
topic and follow its links. Nothing a stranger may not read is ever drawn.

**Topics and categories have addresses of their own:**
`https://bb.fedipod.net/forum/t/<category>/<topic>` and
`https://bb.fedipod.net/forum/c/<category>`. Share copies that form and names
the post. A link with `#/` in it still opens the same topic.

**A topic link pasted into Mastodon shows the topic's name and its opening
words**, and the browser tab shows the topic's or category's name.

**Signing in comes back to the forum's own address** from whichever page it
started on, and then to that page, so a reader's server is asked to approve
one address.

**A topic pinned across the whole forum shows 📌, and one pinned in its
category shows 📍.** Renaming or moving the forum keeps what is pinned across
it; it used to unpin it.

**A post of yours the forum never took in can be sent again.** Once it has
waited an hour, your post in a topic offers Send again; the forum adds it
once, however often it arrives.

## 2026-10-10 (a reply shows in the list of topics within seconds — version 0.4.4)

**A reply you post shows in the forum's list of topics as soon as the forum
has it**, usually within seconds. It could take a minute.

## 2026-10-10 (signing in with a Mastodon account works — version 0.4.3)

**Signing in to the forum with a Mastodon account signs you in.** After
approving the forum at Mastodon, a reader came back signed out.

## 2026-10-10 (posts from Mastodon are readable in the forum — version 0.4.2)

**A post from Mastodon, or any server that sends its text once per language,
shows its text.** It showed "(not readable here)". Every post's text is shown
with only the markup a post may carry, and is stored that way.
