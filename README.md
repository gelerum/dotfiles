# dotfiles

Конфиги для Fedora + niri (Wayland) и для headless-сервера. Раскладка — GNU
stow: каждый каталог верхнего уровня это пакет, внутри него дерево
относительно `$HOME`.

## Установка

```sh
git clone https://github.com/<you>/dotfiles ~/.dotfiles
cd ~/.dotfiles

# сервер (без GUI)
stow -t ~ zsh git nvim starship bat terminfo claude

# десктоп — то же плюс графика
stow -t ~ niri noctalia ghostty satty
```

`stow -R <пакет>` — перелинковать после изменений, `stow -D <пакет>` — снять.
Если stow ругается на конфликт, значит по этому пути уже лежит обычный файл:
уберите или переименуйте его и повторите.

## Инструменты

### Ядро — и на десктопе, и на сервере

| Пакет stow | Инструмент | Зачем |
|---|---|---|
| `zsh` | zsh | History, completion, vi-режим с text objects и surround, fzf-интеграция |
| `nvim` | Neovim **≥ 0.11** | lazy.nvim, LSP, treesitter, telescope. 0.11 обязательна — конфиг зовёт `vim.lsp.config()` и `vim.uv` |
| `starship` | starship | Промпт |
| `git` | git | `~/.config/git/config` |
| `bat` | bat | Конфиг + темы Catppuccin Latte/Mocha (после stow: `bat cache --build`) |
| `terminfo` | — | terminfo для ghostty (`xterm-ghostty`), чтобы работало по SSH |
| `claude` | Claude Code | `~/.claude/settings.json` |

Нужны в PATH: `git`, `ripgrep`, `fd`, `bat`, `eza`, `fzf`, `zoxide`, `direnv`,
`btop`, `make` + `gcc` (сборка `telescope-fzf-native` и парсеров treesitter),
`curl`/`unzip`/`tar` и `python3` + `nodejs` (для mason).

```sh
# Fedora
sudo dnf install zsh git stow neovim ripgrep fd-find bat eza fzf zoxide \
  direnv btop starship nodejs python3 make gcc curl unzip \
  zsh-autosuggestions zsh-syntax-highlighting
```

На Debian/Ubuntu пакеты называются так же, но: `bat` и `fd` ставятся как
`batcat` и `fdfind` (нужны симлинки под короткими именами), а `starship`
и neovim ≥ 0.11 в apt отсутствуют — ставьте их бинарниками с GitHub
Releases в `~/.local/bin`.

Плагины zsh, которых нет в пакетах, — клонировать вручную:

```sh
git clone --depth 1 https://github.com/zsh-users/zsh-history-substring-search \
  ~/.zsh/plugins/zsh-history-substring-search
git clone --depth 1 https://github.com/Aloxaf/fzf-tab ~/.zsh/plugins/fzf-tab
```

Neovim при первом запуске сам поднимает lazy.nvim и через mason-tool-installer
ставит LSP и форматтеры: `lua_ls`, `stylua`, `basedpyright`, `ruff`,
`rust_analyzer`, `gopls`, `goimports`, `gofumpt`. `DEVENV_LANGS="python rust"`
ограничивает список нужными языками.

### Только десктоп (GUI)

| Пакет stow | Инструмент | Зачем |
|---|---|---|
| `niri` | [niri](https://github.com/YaLTeR/niri) | Скроллируемый Wayland-композитор, все клавиши |
| `noctalia` | [noctalia](https://github.com/noctalia-dev/noctalia-shell) | Панель, лаунчер, центр управления + хук `noctalia-battery-guard` (роняет профиль tuned при разряде) |
| `ghostty` | ghostty | Терминал, Catppuccin dark/light по сигналу портала |
| `satty` | satty + `grim`/`slurp` | Аннотация скриншотов, на `Print` в niri |

Ещё нужны: `playerctl`, `grim`, `slurp`, `xwaylandvideobridge`, шрифт
JetBrainsMono Nerd Font.

## Мелочи после установки

- `~/.config/btop/btop.conf` и `btop-latte.conf` не в git: обёртка `btop`
  в `.zshrc` выбирает между ними по теме системы, сам btop создаст файл при
  первом запуске.
