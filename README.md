# dotfiles

```sh
# headless
stow -t ~ zsh git nvim starship bat terminfo claude pi

# desktop
stow -t ~ zsh git nvim starship bat terminfo claude pi niri noctalia ghostty satty
```

## Pi chat UI

[Compact tool output and quote replies](docs/pi-chat-ui.md): select text and press
**Alt+Q** to quote it without losing your draft. **Ctrl+O** expands tool details;
`/ui compact` and `/ui verbose` switch display modes.
