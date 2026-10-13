# Changelog

## v0.1.0 — first release (2026-10-13)

The first public build of ModKeeper (developed as "Mod Hub"). Windows 10/11, 64-bit.

**Install:** download `ModKeeper-Setup-0.1.0.exe` and run it. The installer isn't code-signed, so Windows SmartScreen may say
"Windows protected your PC". Click **More info → Run anyway**. You can compare the file's SHA-256 with the one listed on
the release page first.

**First run:** click **Scan computer**. ModKeeper finds Steam libraries, Vortex, Mod Organizer 2 and game mod folders on its
own. Scanning only reads; nothing changes until you click an action.

### What's in it

- **One library** for Steam Workshop, Nexus/Vortex, Mod Organizer 2, game `Mods` folders, Thunderstore profiles and Prism
  Launcher (Minecraft), shown as a grid, list or carousel, with update checks and a duplicate finder.
- **Your mods stay yours:**
  - **Keep & unsubscribe:** a copy Steam can't update or delete. Updates happen only when you click Update copy, and the
    old version is saved first.
  - **Archive vault:** every Vortex download archive is hard-linked, so it survives Vortex deleting or replacing it.
  - **Asks first:** nothing is deleted (Recycle Bin only), unsubscribed or rewritten without your click, and config files
    are backed up first.
- **Load order** in the games' own files: RimWorld (Auto-sort from About.xml rules, dependency checks), Project Zomboid, Isaac,
  Skyrim SE (plugins, Vortex ↔ MO2 sync, crash log reader), Baldur's Gate 3 (read-only checks).
- **Loadouts:** saved mod lists per game (RimWorld `.rml`, Project Zomboid lists, Isaac, MO2 profiles), with share codes.
- **Emulation:** organizer for your own ROM library. It shows consoles, where files live (synced/PC), RetroArch saves and
  states, romhack details, and duplicates. Play opens RetroArch or BizHawk, and it handles PC ports such as Ship of
  Harkinian mods. Read-only for ROMs.
- **Security:** counts the executables and scripts in each mod and checks them with Microsoft Defender, plus optional
  VirusTotal lookups by fingerprint (no uploads). New or changed mods are checked in the background. Settings can also
  check every mod with programs or DLLs, or run Defender over every mod folder (Workshop, Vortex, MO2, game folders, vault).
- **Workshop browse inside ModKeeper:** star ratings with vote counts, subscriber and favourite counts, and descriptions.
  Favorite, install and subscribe come straight from the cards. It opens on the game you mod most, never on a maps-or-skins
  Workshop like CS2.

- **Emulation tabs:** ROMs & hacks (emulators, PC ports and Syncthing folders below), Mods & modlists (Ship of Harkinian packs
  and saved sets of them), and GameBanana (Mods only; install with checksum + Defender check, favorites).
- **Ship of Harkinian 9:** On/off, load order, installs and modlists write Ship's own enabled-mods list (new packs go on top),
  with a backup of its settings first and only while it's closed. Alternate-assets marker per pack and a tick box for Ship's
  Alternate Assets; rename, delete (Recycle Bin) and Update for GameBanana packs.
- **Mods & modlists for each port:** a game dropdown for Ship of Harkinian, 2 Ship 2 Harkinian and Starship (Starship loads
  every pack A to Z, so it has on/off but no ordering). GameBanana installs go straight into whichever of these you have.
- **Steam browse:** mod count and last page ("of N", type a page to jump), a "Made" filter (past week to past year),
  a tag dropdown from the game's own Workshop tags (e.g. Build 41 / Build 42), a Recently updated sort, and cards that fill
  the screen with full descriptions. Most subscribed now really sorts by subscribers (Steam had been quietly giving Trending).
- **Steam → Downloaded / installed:** Show Installed or Liked; Liked includes hearted mods that aren't installed yet,
  with Install, plus a Hide installed tick.
- **Minecraft tab:** every instance from Prism Launcher, CurseForge, the Modrinth App and the Minecraft Launcher, with
  sub-tabs for mods (on/off, missing-dependency warnings, modlists), resource packs (on/off and order), shaders (pick the
  active pack for Iris or OptiFine), worlds (mode, version, last played; back up to a zip) and screenshots. Browse and
  install from Modrinth (no key) or CurseForge (your API key, in Settings → Accounts), filtered to the instance's version
  and loader, with required dependencies. Updates by file hash (Modrinth) or install record (CurseForge); old files are
  backed up. Deletes go to the Recycle Bin, and nothing changes while that instance is running.
  Worlds open a details panel (created, age, time played, seed, difficulty, data packs, size per dimension) with a
  top-down map centred on your bed, where you were, world spawn, or other players' beds. Versions show their release date.
- **Games:** Minecraft shows as installed (Prism Launcher or the Minecraft Launcher) with the launcher's own art.
- **GameBanana:** pages of 28 with no gaps, mods marked mature shown with an 18+ badge (Settings → Show mature mods on/off).
- **Fix:** "Show in Explorer" opened the wrong place for files with spaces, `&`, `'` or brackets in their names.
- **Window:** fullscreen is optional, with a changeable hotkey (F11 by default).
- **Steam browse:** tabs, filters and paging share one row (three rows of seven results), pages load ahead in the background
  and stay cached (back and forward are instant), and the mouse wheel turns pages.

### Known limits

- Windows only.
- Subscribed Workshop mods still update through Steam; use Keep & unsubscribe for mods you want frozen.
- The Nexus browse carousel needs the separate Vortex plugin repo (see README); everything else works without it.
- Data lives in `%APPDATA%\mod-hub` (set `MODKEEPER_DATA_DIR` to use another folder, e.g. to try a fresh profile).
