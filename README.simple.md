# Rewind (The Plain-English Guide)

> **Think of Rewind as a video game quick-save and "Ctrl+Z" button for AI coding agents.**

If you build apps using tools like **Claude Code, Cursor, Aider, or ChatGPT**, you already know the sinking feeling: you ask the AI to make a small change, and five minutes later your site won't start, your files are scrambled, and your API keys are gone.

You don't need to be a terminal wizard or a Git expert to use Rewind. This guide explains what it does, why it exists, and how to use it in plain language.

---

## 🛑 The Problem: AIs Are Messy Roommates

When an AI writes code on your computer, it doesn't just edit text files. It can run commands in your terminal. 

Sometimes, the AI:
1. **Accidentally deletes your `.env` file** — where you keep your private OpenAI keys, Stripe passwords, and database links. (Because Git ignores `.env` files by default, once deleted, regular Git can never bring it back).
2. **Goes down a hallucination spiral** — changing 20 files at once until nothing compiles, leaving you with no idea what it touched.
3. **Runs dangerous terminal commands** — like `rm -rf` or overwriting important folders.

If you don't know advanced Git commands like `git reflog`, `git reset --hard`, or `git checkout -b`, trying to recover your work is terrifying. One wrong command and your code is gone for good.

---

## 🛡️ What Rewind Does

Rewind acts like an **uncrashable black box flight recorder** running silently in the background while your AI works.

```
       AI makes a change (3:01 PM)  ───► Rewind automatically saves a checkpoint
       AI makes a change (3:02 PM)  ───► Rewind automatically saves a checkpoint
       AI deletes your .env (3:03 PM) ───► 💥 DISASTER!
                                                │
                                    Type: rewind undo 1
                                                ▼
       Everything restored to 3:02 PM in 12 milliseconds! ✨
```

* **Instant Undo:** Type `rewind undo 1` and your whole project jumps back to before the AI made its mistake.
* **Saves What Git Forgets:** It automatically protects your `.env` files, local settings, and SQLite databases.
* **Visual Time Machine:** Type `rewind ui` to open an interactive timeline. You can press the arrow keys to walk backwards through time and see exactly what changed before hitting Enter to restore.
* **Zero Fear:** Rewind never messes up your real Git history or deletes your branches. It's completely non-destructive.

---

## 🚀 How to Use Rewind in 3 Steps

### Step 1: Install
Open your terminal and install Rewind:
```bash
npm install -g rewind
```
*(Or clone this repository and run `npm install && npm run build`)*

### Step 2: Start your AI with Rewind
Instead of running your AI directly, put `rewind run` in front of it:

```bash
# If you use Claude Code:
rewind run claude

# If you use Aider:
rewind run aider
```

Now use your AI just like you normally would. Rewind sits in the background, quietly saving a checkpoint every time a file changes.

### Step 3: Hit Undo whenever something goes wrong
If the AI makes a mess:

#### Option A: Quick Undo
To undo the last step the AI took:
```bash
rewind undo 1
```
To undo the last 3 steps:
```bash
rewind undo 3
```

#### Option B: The Visual Scrubber (Recommended!)
If you want to see what you're doing before you undo:
```bash
rewind ui
```
You'll see a clean visual dashboard:
* Use the **Up/Down arrow keys** to highlight earlier checkpoints.
* The right side shows green lines (added code) and red lines (deleted code).
* Press **Enter** to instantly jump back to that point in time.
* Press **q** to quit.

---

## 💡 Frequently Asked Questions

### Do I need to understand Git to use this?
**No.** Rewind was built specifically so you don't have to touch scary Git commands when an AI messes up. It handles all the snapshotting and restoring behind the scenes.

### Will it slow down my computer or agent?
**No.** Rewind saves checkpoints in less than 5 milliseconds (faster than the blink of an eye). You won't even notice it running.

### What happens to my API keys and `.env` files?
This is Rewind's superpower. Regular Git refuses to touch `.env` files for security reasons. But Rewind saves safe local backups in a private storage locker. If an AI accidentally wipes out your `.env`, Rewind puts it back in place immediately.

### How is this different from regular `Ctrl+Z` in my code editor?
`Ctrl+Z` in VS Code or Cursor only works inside one open file, and only if you haven't closed the tab. It cannot undo files that were deleted, and it cannot undo terminal commands. Rewind watches your entire project folder and restores everything at once.

---

## 🎯 Cheat Sheet

| Command | What it does |
|---|---|
| `rewind run <agent>` | Starts your AI inside the flight recorder |
| `rewind undo 1` | Undoes the last change the AI made |
| `rewind undo 5` | Jumps back 5 steps |
| `rewind ui` | Opens the visual timeline scrubber |
| `rewind status` | Shows what session is currently active |

Now you can let your AI code with peace of mind!
