# SHATTERPOINT — IP Policy

**This file governs every roster addition, every theme, every kit, every name and every string
in the project — including comments, placeholder text, asset filenames and commit messages.**

---

## The rule

All content is **original**, or drawn from the **public-domain mythological record**.

Nothing else. There is no third category.

## Mythological content comes from primary sources

Where a figure, creature or event is mythological, it is taken from the **primary text**:
Hesiod, Homer, the Poetic and Prose Eddas, the Mahābhārata and Rāmāyaṇa, Ovid, the Kalevala,
the Epic of Gilgamesh, and their peers — works long out of copyright.

**Never from an adaptation.** Not from a film, a comic, a game, a television series, a
tabletop supplement, a toy line, or a wiki page that summarises one. Adaptations carry their
own protected design: a helmet shape, a weapon silhouette, a costume palette, a redesigned
creature, a name that exists only in that adaptation. Reading the source and reading a
retelling produce different work, and only one of them is safe.

If you cannot cite the primary text a detail came from, it did not come from the primary text.

## What is forbidden

From **any** existing property — Marvel, DC, One Piece, Naruto, Dragon Ball, Transformers, or
any other, without limit to that list:

* **Characters.** No name, no likeness, no silhouette, no signature pose, no catchphrase, no
  origin, no relationship, no serial number.
* **Costume and design.** No costume, armour, mask, helmet, weapon or vehicle design.
* **Logos and marks.** No logo, emblem, insignia, sigil or wordmark.
* **Colour identity.** No colour scheme that functions as identification — the specific
  combination that makes a figure recognisable at a glance, in silhouette or at backdrop scale.
* **Trade dress.** No title treatment, typeface pairing, UI look, sound sting or overall
  presentation that evokes a specific property.

This applies to code, identifiers, type unions, data records, comments, TODOs, test fixtures,
placeholder strings, asset filenames and internal-only material. "It is only a placeholder" is
not an exception — placeholders ship.

## Archetype overlap is legitimate. Specific-character reproduction is not.

An **archetype** is a role, a mass, a gait, a function. Archetypes are ancient, shared and
unownable, and SHATTERPOINT uses them deliberately:

* a **thunder-bringer** — storm gods predate every modern publisher by three thousand years
* a **transforming titan** — a machine that unfolds into another machine
* a **boarding crew** — sailors taking a hull apart in a standing swell
* a colossus, a lancer, an archer, a shieldbearer, a serpent, a wyrm

Those are legitimate and none of them needs anyone's permission.

What converts a legitimate archetype into an infringement is **specificity**: the moment the
thunder-bringer acquires a particular publisher's helmet, hammer, cape colour, blond hair and
name, it stops being an archetype and becomes a copy. The same for a transforming machine that
acquires a specific truck cab, a specific faction insignia, or a specific red-and-blue split;
the same for a boarding crew that acquires a specific straw hat.

The test to apply, honestly:

> **Would a fan of that property recognise this as *their* character rather than as *a*
> character of that kind?**

If yes — or if you are unsure — it is out. Change it until the answer is a clear no. This is a
one-way test: the burden is on the addition to prove it is generic, never on a reviewer to
prove it is not.

## Practical guidance for the backdrop cast

The battle layer's figures are silhouettes at parallax distance — mass and gait, never a
recognisable design. Build them from:

* **Function**: what does this shape *do* on the backdrop? A slow immense thing; a thing that
  darts; a thing that unfolds.
* **Proportion**: the ratio of mass to limb, and how it moves.
* **The universe's own palette**: colour comes from the `UniverseTheme` record, which is
  authored for the histogram in `docs/ARCHITECTURE.md` §6 — not from a character's identity.

Names come from the universe's own vocabulary — architecture, materials, weather, ritual — or
from the primary mythological record. Never from a character in anything.

## Applying this policy

* Every new roster, silhouette, theme, kit or name is reviewed against this file **before** it
  is written, not after.
* A reviewer's uncertainty is a rejection, not a discussion. Rework, then re-submit.
* If a proposed addition needs an argument to survive this policy, it does not survive it.
