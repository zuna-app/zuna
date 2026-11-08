// Characters that change how text around them is shown, or show nothing at all: what a
// name, a reaction or a link's preview could use to look like something it isn't.

// What changes how the text around it reads, or hides in it. With these, "photo‮gnp.exe"
// reads as if it ended in ".png". Joiners stay: some scripts and emoji need them.
export const HIDDEN_CHARACTERS = /[؜​‎‏‪-‮⁠⁦-⁩﻿]/g;

/** A name to show, as what it really says. */
export const plainName = (name: string): string => name.replace(HIDDEN_CHARACTERS, "");
