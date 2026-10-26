# Changelog

## 0.0.5, 2026-10-26

Automatically switch to a surviving main or master worktree when the active
worktree is deleted, including when the panel is closed. Add a Main branch
setting to choose a different branch to switch to. Preserve the existing editor
buffer recovery and report when no suitable worktree is available.

## 0.0.4, 2026-10-21

Add the Worktree Switcher icon to the ribbon and panel tab. Rename the panel
command and ribbon tooltip to "Switch Worktrees".

## 0.0.3, 2026-10-21

Add a reproducible `npm run build` command for verification. Document the
filesystem access required to view and switch worktrees, save recovery files,
and refresh Obsidian's file tree.

## 0.0.2, 2026-10-21

Add an npm lockfile and attested release builds. Release assets now contain only
Obsidian's three installation files. Restrict previews to the selected worktree
and disable Git text-conversion commands when showing diffs.

## 0.0.1, 2026-10-21

Desktop beta. Switch between Git worktrees in the same Obsidian window, inspect
changed-file diffs, and preview Markdown. Requires Obsidian 1.14.4 or later.
