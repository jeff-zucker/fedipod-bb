# Changes

Changes up to and including 0.4.1 are recorded in FediPod's
[CHANGES.md](https://github.com/jeff-zucker/FediPod/blob/main/CHANGES.md),
under the headings that name fedipod-bb.

## 2026-11-14 (a moderator's own deletion waiting in the queue is carried out — version 0.5.5)

**A moderator who deleted their own post, and saw it stay, has it deleted.**
FediPod before 1.57.5 held a moderator's deletion of their own post as a
moderation request that nothing could confirm. The forum carries out any such
request on its next run, once the post is gone where its author keeps it, and
takes it out of the queue. A moderator's request about someone else's post is
left as it is. With FediPod 1.57.5 a new deletion is carried out as it
arrives.

## 2026-11-14 (a sign-in the pod has ended is not shown as signed in — version 0.5.4)

**The forum's page asks your pod before it says "signed in".** A sign-in your
pod has ended shows as signed out, with your handle already in the sign-in
box. A pod that is down does not sign you out.

**A reply that finds the sign-in ended keeps your words.** The reply box says
the sign-in has ended and offers the way back in, and what you wrote is in the
box again when you open it after signing in. Any other action that finds the
same opens the sign-in box. This needs fediverse-session 0.2.2.

## 2026-11-14 (a kept forum says when it next has work — version 0.5.3)

**A forum kept by a Gateway is run again when it has work.** It says when in a
form the Gateway reads: at once when a run left mail in its inbox, and at a
delivery's next try. It said so before in a form the Gateway could not read,
so a delivery that failed waited for the next post. This needs FediPod 1.57.3
at the Gateway.

**What waits for a moderator brings back no run.** A post held for review and
a report stay in the queue until a moderator deals with them. A request from a
listed moderator, which the forum confirms at the moderator's own server and
carries out by itself, is tried again each round for the first hour after it
arrives.

## 2026-11-13 (a kept forum takes its mail in again — version 0.5.2)

**A forum kept by a Gateway takes in everything sent to it again.** After a
change to the forum's settings, posts, replies and follows sent to it were
accepted and never appeared. They appear now, and what was waiting is taken
in, fifty items a run.

## 2026-10-21 (the forum's own robots.txt — version 0.5.1)

**The forum's host asks search engines to stay out**, with a `robots.txt`
that comes with the forum's page. Only the front page, a category and a topic
arrive drawn; any other address under the forum is built in the browser.

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
