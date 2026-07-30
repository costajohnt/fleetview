# The README demo. Regenerate with: vhs demo.tape
#
# Drives scripts/demo.ts — the real roster against a scripted fake opencode — with real keystrokes,
# so what the GIF shows is the shipped UI reacting to real input rather than a drawn mockup.

Output docs/demo.gif

Set Shell zsh
Set FontSize 15
Set Width 1180
Set Height 520
Set Padding 22
Set Theme "Catppuccin Mocha"
Set TypingSpeed 55ms

# Boot off camera: the shell line isn't part of the demo.
Hide
Type "node scripts/demo.ts"
Enter
Sleep 2.5s
Show

# The roster as you find it: one session working, one blocked on a permission, one done.
Sleep 2.5s

# Dispatch a new task from the input at the bottom.
Type "add the retry budget to the client"
Sleep 800ms
Enter

# It names itself, streams progress, then blocks on a question.
Sleep 6.5s

# Peek at what it's asking, and answer it without ever leaving the roster.
Space
Sleep 3.5s
Type "1"
Sleep 4s
Escape
Sleep 2s

# The keymap.
Type "?"
Sleep 3s
Escape
Sleep 1.2s

Ctrl+C
Sleep 500ms
