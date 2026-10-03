# =============================================================================
# 1. HISTORY CONFIGURATION
# =============================================================================
HISTFILE="$HOME/.zsh_history"
HISTSIZE=50000
SAVEHIST=50000
setopt APPEND_HISTORY
setopt SHARE_HISTORY
setopt HIST_IGNORE_ALL_DUPS
setopt HIST_IGNORE_SPACE
setopt HIST_REDUCE_BLANKS
setopt HIST_VERIFY               # Show !! expansion before running it
setopt EXTENDED_HISTORY          # Save timestamps with each command
setopt HIST_SAVE_NO_DUPS         # Don't write duplicate entries to the file
setopt HIST_FIND_NO_DUPS         # Don't show dups while scrolling history
# (APPEND_HISTORY above is redundant — SHARE_HISTORY already implies it.)

# =============================================================================
# 1b. GENERAL SHELL OPTIONS  (all of these are OFF by default in zsh)
# =============================================================================
setopt INTERACTIVE_COMMENTS      # allow `cmd # comment` — errors without this
setopt EXTENDED_GLOB             # ^, ~, **, (#i) glob operators
setopt NUMERIC_GLOB_SORT         # file10 sorts after file9, not before
setopt NO_CLOBBER                # `>` won't overwrite; use `>|` to force
setopt AUTO_PUSHD                # every cd pushes to the dir stack...
setopt PUSHD_IGNORE_DUPS         # ...without duplicates...
setopt PUSHD_SILENT              # ...and without printing the stack
setopt NO_BEEP
alias d='dirs -v'                # then `cd -2` to jump back two dirs

# =============================================================================
# 2. AUTO-COMPLETIONS & BEHAVIOR
# =============================================================================
# Cached compinit — much faster shell startup.
#
# NOTE: glob qualifiers are NOT expanded inside [[ ... ]], so the old
#   if [[ -n ${ZDOTDIR:-$HOME}/.zcompdump(#qN.mh+24) ]]
# was ALWAYS true and always ran the slow full compinit. Glob must be
# expanded into an array outside of [[ ]] for the cache check to work.
autoload -Uz compinit
_zcompdump="${ZDOTDIR:-$HOME}/.zcompdump"
_zdump_stale=("$_zcompdump"(N.mh+24))     # non-empty only if older than 24h
if (( ${#_zdump_stale} )) || [[ ! -s "$_zcompdump" ]]; then
  compinit -d "$_zcompdump"               # full run: rebuild + security check
else
  compinit -C -d "$_zcompdump"            # fresh: skip checks, fast path
fi
unset _zcompdump _zdump_stale

# Colors for the completion menu.
# The old config used $LS_COLORS, which is empty when you use eza instead of
# GNU ls + dircolors — so menu colors silently did nothing.
if (( $+commands[dircolors] )); then
  eval "$(dircolors -b)"
fi

zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}' 'r:|=*' 'l:|=* r:|=*'
zstyle ':completion:*' menu select
zstyle ':completion:*' list-colors "${(s.:.)LS_COLORS}"
zstyle ':completion:*' verbose true
zstyle ':completion:*:descriptions' format '%F{yellow}-- %d --%f'

# --- Built-in completion menu (menuselect) keys ------------------------------
# zmodload is REQUIRED: without it the `menuselect` keymap does not yet exist
# when .zshrc is read and every bindkey -M menuselect below fails.
#
# zsh's stock menuselect binds almost nothing — notably there is NO cancel key.
# In this menu, Enter only INSERTS the highlighted item and leaves the menu;
# press Enter a second time to actually run the command.
#
# NOTE: if fzf-tab is installed (section 9) it replaces this menu entirely and
# these bindings never fire. They are kept as a fallback for `disable-fzf-tab`.
zmodload zsh/complist
bindkey -M menuselect 'h' vi-backward-char
bindkey -M menuselect 'j' vi-down-line-or-history
bindkey -M menuselect 'k' vi-up-line-or-history
bindkey -M menuselect 'l' vi-forward-char
bindkey -M menuselect '^M' accept-line         # Enter  — confirm selection
bindkey -M menuselect '^I' accept-and-hold     # Tab    — pick and stay in menu
bindkey -M menuselect '^G' send-break          # Ctrl+G — cancel
bindkey -M menuselect '^[' send-break          # Esc    — cancel
bindkey -M menuselect '/'  history-incremental-search-forward  # filter menu

# =============================================================================
# 3. ALIASES & MODERN REPLACEMENTS
# =============================================================================
alias rm='rm -i'
alias cp='cp -i'
alias mv='mv -i'

alias ls="eza --icons=always"
alias ll="eza -lah --icons=always --git"
# --level caps depth so `tree` in a node_modules/ dir doesn't dump 50k lines.
# --git-ignore hides build artefacts. Use `eza --tree` directly for unlimited.
alias tree="eza --tree --level=2 --git-ignore --icons=always"
# btop не умеет менять тему на лету и читает конфиг только при старте, поэтому
# тему выбираем в момент запуска — по тому же сигналу портала, который
# переключает весь десктоп в 06:00 и 20:00 (его выставляет хук noctalia).
# Флаг -c принимает произвольный конфиг; оба файла лежат в ~/.config/btop/.
#
# Внутри btop: "p" листает пресеты. Пресет 1 — только CPU и процессы,
# он влезает в половину экрана, где полный набор блоков не помещается.
# Обёртка названа btop, а не top: иначе набранное по привычке "btop"
# проходит мимо неё и запускает дефолтный конфиг с mocha.
# "command btop" обязателен — без него функция вызовет сама себя.
btop() {
  local cfg="$HOME/.config/btop/btop.conf"          # mocha
  if [[ "$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null)" == *light* ]]; then
    cfg="$HOME/.config/btop/btop-latte.conf"
  fi
  command btop -c "$cfg" "$@"
}
alias top=btop
# --paging=never keeps `cat` behaving like cat: bat otherwise opens a pager
# on long files, which is surprising in the middle of a pipeline of thought.
alias cat="bat --paging=never"
alias catp="bat"                 # ...and this one when you DO want the pager
alias grep='grep --color=auto'

alias vim="nvim"
alias vi="nvim"
alias v="nvim"

# =============================================================================
# 4. YAZI FILE MANAGER INTEGRATION
# =============================================================================
function y() {
	local tmp="$(mktemp -t "yazi-cwd.XXXXXX")"
	yazi "$@" --cwd-file="$tmp"
	if cwd="$(cat -- "$tmp")" && [ -n "$cwd" ] && [ "$cwd" != "$PWD" ]; then
		builtin cd -- "$cwd"
	fi
	rm -f -- "$tmp"
}
alias fm="y"
alias yy="yazi"

# =============================================================================
# 5. VI MODE + KEYBINDINGS
# =============================================================================
bindkey -v

# Esc latency vs. multi-byte key sequences (arrows, Home/End = ^[[A, ^[[C ...).
# KEYTIMEOUT is in hundredths of a second. 1 (=10ms) makes Esc instant but can
# break arrow keys / make you fall into vicmd by accident. 5 (=50ms) is still
# imperceptible and much more reliable. Raise to 20 if you use this over SSH.
export KEYTIMEOUT=5

# Free Ctrl+S: by default the terminal eats it as XOFF (flow control) and the
# screen appears frozen (Ctrl+Q unfreezes). Without this, the ^S binding below
# never reaches zsh.
stty -ixon 2>/dev/null

# Ctrl+W / word-motions: zsh's default WORDCHARS is
#     *?_-.[]~=/&;!#$%^(){}<>
# It contains "/", so Ctrl+W on ~/1Projects/aes-like-distinguisher nukes the
# WHOLE path. Dropping / = and : makes Ctrl+W delete one path segment at a time.
WORDCHARS='*?_-.[]~&;!#$%^(){}<>'

# Standard movement (these work in insert mode)
bindkey '^A' beginning-of-line
bindkey '^E' end-of-line
bindkey '^K' kill-line
bindkey '^U' backward-kill-line
bindkey '^W' backward-kill-word
bindkey '^Y' yank

# Reverse / forward incremental search
bindkey '^R' history-incremental-search-backward
bindkey '^S' history-incremental-search-forward

# --- VISUAL MODE (this is what you actually wanted) -------------------------
# zsh has a real visual mode built in. The OLD config did:
#     bindkey -M vicmd 'v' edit-command-line
# which CLOBBERED it — that is why pressing v launched nvim.
# Left alone, the defaults are:
#     v  -> visual-mode        (character-wise selection)
#     V  -> visual-line-mode   (line-wise selection)
# then d / c / y / x operate on the selection, all inside zsh.
# We re-assert them explicitly so a plugin can't silently steal them again.
bindkey -M vicmd 'v' visual-mode
bindkey -M vicmd 'V' visual-line-mode

# Useful extras inside visual mode
bindkey -M visual 'd' vi-delete
bindkey -M visual 'x' vi-delete
bindkey -M visual 'y' vi-yank
bindkey -M visual 'c' vi-change
bindkey -M visual '~' vi-swap-case

# --- VIM TEXT OBJECTS: ci" di( ca[ ... --------------------------------------
# These functions ship WITH zsh (/usr/share/zsh/functions/Zle/), no plugin
# needed. They give you real text objects in operator-pending + visual mode.
autoload -Uz select-bracketed select-quoted
zle -N select-bracketed
zle -N select-quoted
for _m in visual viopp; do
  # i" i' i` i, i. i/ i: i; i= i+ i@ i| ... and the a-variants
  for _c in {a,i}${(s..)^:-\'\"\`\|,./:;=+@}; do
    bindkey -M $_m -- "$_c" select-quoted
  done
  # i( i[ i{ i< ib iB ... and the a-variants
  for _c in {a,i}${(s..)^:-'()[]{}<>bB'}; do
    bindkey -M $_m -- "$_c" select-bracketed
  done
done
unset _m _c

# --- VIM SURROUND: ds" cs"' ysiw" -------------------------------------------
# Also built into zsh. Normal mode:
#   ds"      delete the surrounding quotes
#   cs"'     change surrounding " into '
#   ysiw"    wrap the word under the cursor in quotes
# Visual mode:
#   S"       wrap the selection in quotes
autoload -Uz surround
zle -N delete-surround surround
zle -N add-surround surround
zle -N change-surround surround
bindkey -M vicmd  'cs' change-surround
bindkey -M vicmd  'ds' delete-surround
bindkey -M vicmd  'ys' add-surround
bindkey -M visual 'S'  add-surround

# --- Open the current command line in nvim, ON PURPOSE ----------------------
autoload -Uz edit-command-line
zle -N edit-command-line
bindkey -M vicmd '^V' edit-command-line   # normal mode: Ctrl+V
bindkey -M viins '^X^E' edit-command-line # insert mode: Ctrl+X Ctrl+E (bash-style)

# NOTE: j/k history bindings are set in section 9, AFTER the
# zsh-history-substring-search plugin is sourced. Binding them before
# the plugin loads is why scrolling silently failed before.

# =============================================================================
# 6. VI MODE CURSOR SHAPE
# =============================================================================
# Block in normal/visual mode, beam in insert mode.
# The old version had no case for the `visual` keymap, so the cursor stayed a
# beam while selecting text.
# This is the SINGLE keymap-select handler. It does two jobs (cursor shape and
# the N/I/V prompt indicator) because `zle -N` overwrites: registering a second
# zle-keymap-select anywhere below would silently disable this one.
_vi_mode='%F{blue}I%f'
function zle-keymap-select {
  case ${KEYMAP} in
    vicmd)         echo -ne '\e[1 q'; _vi_mode='%F{yellow}N%f' ;;  # block
    visual|viopp)  echo -ne '\e[1 q'; _vi_mode='%F{magenta}V%f' ;; # block
    main|viins|'') echo -ne '\e[5 q'; _vi_mode='%F{blue}I%f' ;;    # beam
  esac
  # Only redraw if we actually own the prompt (starship redraws itself)
  (( ${+_zsh_native_prompt} )) && zle reset-prompt 2>/dev/null
}
zle -N zle-keymap-select

# NOTE: zle-line-init (beam cursor on new prompt) is defined at the END of
# section 9, because it also has to handle terminal application-keypad mode.
# Defining it twice would silently clobber one of the two jobs.

# Use add-zsh-hook instead of defining preexec directly, so tools that also
# install a preexec hook (direnv, starship, etc.) don't overwrite each other.
autoload -Uz add-zsh-hook
_reset_cursor_beam() { echo -ne '\e[5 q'; }
add-zsh-hook preexec _reset_cursor_beam


# =============================================================================
# 8. NAVIGATION (zoxide)
# =============================================================================
# --cmd cd makes `cd foo` a zoxide jump while preserving cd -, cd .., completion.
if (( $+commands[zoxide] )); then
  eval "$(zoxide init zsh --cmd cd)"
fi

# Per-directory environments (.envrc). `direnv allow` on its own does nothing
# without this: allowing only marks the file trusted, it is the shell hook that
# actually loads it on chpwd/precmd. Installed after zoxide so it hooks the
# `cd` that zoxide defines.
if (( $+commands[direnv] )); then
  eval "$(direnv hook zsh)"
fi

# =============================================================================
# 9. SYNTAX HIGHLIGHTING, AUTOSUGGESTIONS, SUBSTRING SEARCH (Fedora)
# =============================================================================
# Install:
#   sudo dnf install zsh-autosuggestions zsh-syntax-highlighting
#   git clone https://github.com/zsh-users/zsh-history-substring-search \
#     ~/.zsh/plugins/zsh-history-substring-search
#
# Order matters: autosuggestions → syntax-highlighting → substring-search

# --- fzf: fuzzy Ctrl+R / Ctrl+T --------------------------------------------
#   sudo dnf install fzf
# This replaces the (fairly clunky) history-incremental-search on ^R with a
# fuzzy, previewable one, and adds ^T to insert a file path into the command.
if (( $+commands[fzf] )); then
  # zsh 5.9 + fzf 0.48+: shell integration is exposed via `fzf --zsh`
  if fzf --zsh >/dev/null 2>&1; then
    source <(fzf --zsh)
  else
    [ -f /usr/share/fzf/shell/key-bindings.zsh ] && \
      source /usr/share/fzf/shell/key-bindings.zsh
    [ -f /usr/share/fzf/shell/completion.zsh ] && \
      source /usr/share/fzf/shell/completion.zsh
  fi

  export FZF_DEFAULT_OPTS="--height=45% --layout=reverse --border --info=inline"
  # Preview files with bat, directories with eza — you already have both.
  export FZF_CTRL_T_OPTS="--preview '
      if [ -d {} ]; then eza --tree --level=2 --color=always {};
      else bat --color=always --style=numbers --line-range=:200 {}; fi'"
  export FZF_CTRL_R_OPTS="--preview 'echo {}' --preview-window=down:3:hidden:wrap
      --bind '?:toggle-preview'"
  if (( $+commands[fd] )); then
    export FZF_DEFAULT_COMMAND='fd --type f --hidden --follow --exclude .git'
    export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
  fi
fi

# --- fzf-tab: fuzzy the TAB completion menu itself --------------------------
#   git clone https://github.com/Aloxaf/fzf-tab ~/.zsh/plugins/fzf-tab
# Must load AFTER compinit and BEFORE autosuggestions/syntax-highlighting.
if [ -f "$HOME/.zsh/plugins/fzf-tab/fzf-tab.plugin.zsh" ]; then
  # fzf-tab requires the built-in menu to be OFF, or the two fight over ^I
  zstyle ':completion:*' menu no
  source "$HOME/.zsh/plugins/fzf-tab/fzf-tab.plugin.zsh"

  # fzf-tab defaults use-fzf-default-opts to "no", i.e. it IGNORES
  # $FZF_DEFAULT_OPTS set above — the completion menu would render full-height
  # and unstyled while Ctrl+R/Ctrl+T look right. Turn it on.
  zstyle ':fzf-tab:*' use-fzf-default-opts yes

  # Keys inside the fzf menu (hjkl is impossible here — letters go into the
  # search query). fzf's own defaults already give you Ctrl+J / Ctrl+K.
  #   Enter        confirm          Esc / Ctrl+C  cancel
  #   Tab / S-Tab  down / up        Ctrl+Space    multi-select
  #   , / .        switch group     /             continue into subdirectory
  zstyle ':fzf-tab:*' fzf-bindings 'ctrl-d:preview-page-down' 'ctrl-u:preview-page-up'
  zstyle ':fzf-tab:*' switch-group ',' '.'
  zstyle ':fzf-tab:*' continuous-trigger '/'

  zstyle ':fzf-tab:complete:cd:*' fzf-preview 'eza --tree --level=2 --color=always $realpath'
  zstyle ':fzf-tab:complete:__zoxide_z:*' fzf-preview 'eza --tree --level=2 --color=always $realpath'
fi

[ -f /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh ] && \
  source /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh

[ -f /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh ] && \
  source /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

[ -f "$HOME/.zsh/plugins/zsh-history-substring-search/zsh-history-substring-search.zsh" ] && \
  source "$HOME/.zsh/plugins/zsh-history-substring-search/zsh-history-substring-search.zsh"

# --- Autosuggestions -------------------------------------------------------
ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=#6c7086,italic'
ZSH_AUTOSUGGEST_STRATEGY=(history completion)

# Accepting the inline suggestion.
# The old config only had `bindkey '^ ' autosuggest-accept`. zsh normalises
# "^ " to "^@" (a NUL byte), which most terminals never actually send on
# Ctrl+Space — so the suggestion looked un-acceptable. Bind real keys instead:
bindkey -M viins '^F'  autosuggest-accept        # Ctrl+F  -> accept whole suggestion
bindkey -M viins '^]'  autosuggest-accept        # Ctrl+]  -> spare, always works
bindkey -M viins '^ '  autosuggest-accept        # Ctrl+Space, if your term sends it
bindkey -M viins '^[f' forward-word              # Alt+F   -> accept ONE word
# (Ctrl+E / End / Right-arrow also accept the suggestion via the plugin defaults.)

# Don't let autosuggestions fight with visual selection
ZSH_AUTOSUGGEST_CLEAR_WIDGETS+=(visual-mode visual-line-mode)

# --- Syntax highlighting tweaks --------------------------------------------
ZSH_HIGHLIGHT_HIGHLIGHTERS=(main brackets pattern cursor)
typeset -gA ZSH_HIGHLIGHT_STYLES
ZSH_HIGHLIGHT_STYLES[command]='fg=green,bold'
ZSH_HIGHLIGHT_STYLES[builtin]='fg=cyan,bold'
ZSH_HIGHLIGHT_STYLES[alias]='fg=cyan,bold'
ZSH_HIGHLIGHT_STYLES[function]='fg=cyan,bold'
ZSH_HIGHLIGHT_STYLES[path]='fg=blue,underline'
ZSH_HIGHLIGHT_STYLES[unknown-token]='fg=red,bold'
ZSH_HIGHLIGHT_STYLES[single-quoted-argument]='fg=yellow'
ZSH_HIGHLIGHT_STYLES[double-quoted-argument]='fg=yellow'

# --- History substring search bindings (widgets exist now) ------------------
bindkey -M vicmd 'k' history-substring-search-up
bindkey -M vicmd 'j' history-substring-search-down
bindkey -M viins '^P' history-substring-search-up
bindkey -M viins '^N' history-substring-search-down

# Arrow keys / Home / End / Delete via terminfo.
# Hardcoding '^[[A' is a common bug: in "application cursor key" mode the
# terminal sends '^[OA' instead, and the binding silently does nothing.
# We bind BOTH the terminfo value and the raw fallback so it works everywhere.
zmodload zsh/terminfo 2>/dev/null
typeset -A _keys=(
  Up     "${terminfo[kcuu1]}"  Down   "${terminfo[kcud1]}"
  Left   "${terminfo[kcub1]}"  Right  "${terminfo[kcuf1]}"
  Home   "${terminfo[khome]}"  End    "${terminfo[kend]}"
  Delete "${terminfo[kdch1]}"
)
_bk() {  # _bk <widget> <keyseq...>
  local widget=$1; shift
  local seq
  for seq in "$@"; do
    [[ -n $seq ]] && bindkey -M viins "$seq" "$widget"
  done
}
_bk history-substring-search-up   "${_keys[Up]}"    '^[[A' '^[OA'
_bk history-substring-search-down "${_keys[Down]}"  '^[[B' '^[OB'
_bk beginning-of-line             "${_keys[Home]}"  '^[[H' '^[OH' '^[[1~'
_bk end-of-line                   "${_keys[End]}"   '^[[F' '^[OF' '^[[4~'
_bk delete-char                   "${_keys[Delete]}" '^[[3~'
unfunction _bk; unset _keys

# Make Home/End work in normal mode too
bindkey -M vicmd '^[[H' beginning-of-line
bindkey -M vicmd '^[[F' end-of-line

# Application-keypad mode: terminfo's ^[O-prefixed sequences are only emitted
# if we put the terminal into that mode for the duration of each prompt.
# NOTE: zle-line-init is ALSO used for the cursor shape in section 6, and
# `zle -N` overwrites rather than chains — so both jobs live in one function.
_zle_app_mode=1
zle-line-init() {
  (( _zle_app_mode )) && (( ${+terminfo[smkx]} )) && echoti smkx
  echo -ne '\e[5 q'          # beam cursor (insert mode)
}
zle-line-finish() {
  (( _zle_app_mode )) && (( ${+terminfo[rmkx]} )) && echoti rmkx
}
zle -N zle-line-init
zle -N zle-line-finish

HISTORY_SUBSTRING_SEARCH_HIGHLIGHT_FOUND='bg=magenta,fg=white,bold'
HISTORY_SUBSTRING_SEARCH_HIGHLIGHT_NOT_FOUND='bg=red,fg=white,bold'

# =============================================================================
# 10. ENVIRONMENT VARIABLES
# =============================================================================
export GENSIM_DATA_DIR="$HOME/.gensim-data"
export EDITOR="nvim"
export VISUAL="nvim"
export PATH="$HOME/.local/bin:$PATH"
export SOPS_AGE_KEY_FILE="$HOME/.config/age/sops.age"
export GOPASS_AGE_IDENTITIES_FILE="$HOME/.config/age/gopass.age"

# Point at the user-service ssh-agent, but only if that socket really exists.
# Two guards, both load-bearing:
#   - XDG_RUNTIME_DIR unset (su, cron, some SSH sessions) would otherwise
#     produce the bogus path "/ssh-agent.socket";
#   - on a server reached with `ssh -A`, sshd already set SSH_AUTH_SOCK to a
#     forwarded socket in /tmp. Overwriting it unconditionally kills agent
#     forwarding, so we only override when a local agent socket is present.
if [[ -n "$XDG_RUNTIME_DIR" && -S "$XDG_RUNTIME_DIR/ssh-agent.socket" ]]; then
  export SSH_AUTH_SOCK="$XDG_RUNTIME_DIR/ssh-agent.socket"
fi

# =============================================================================
# 11. PROMPT
# =============================================================================
# Your previous config set no prompt at all — what you saw was Fedora's
# /etc/zshrc default, which has no git info. Since you already use `eza --git`,
# a branch/dirty indicator in the prompt is probably worth it.
#
# Preferred: starship (`sudo dnf install starship`). If it isn't installed we
# fall back to a small native vcs_info prompt — no plugins, no subshell per
# keystroke, and it also shows the vi mode you're in.
if (( $+commands[starship] )); then
  eval "$(starship init zsh)"
else
  autoload -Uz vcs_info add-zsh-hook
  zstyle ':vcs_info:*' enable git
  zstyle ':vcs_info:git:*' check-for-changes true
  zstyle ':vcs_info:git:*' unstagedstr '%F{yellow}*%f'
  zstyle ':vcs_info:git:*' stagedstr   '%F{green}+%f'
  zstyle ':vcs_info:git:*' formats     ' %F{magenta}%b%f%u%c'
  zstyle ':vcs_info:git:*' actionformats ' %F{magenta}%b%f|%F{red}%a%f%u%c'
  add-zsh-hook precmd vcs_info

  # The N/I/V indicator itself is maintained by the single zle-keymap-select
  # handler in section 6. This flag just tells it that redrawing is safe.
  _zsh_native_prompt=1

  setopt PROMPT_SUBST
  PROMPT='${_vi_mode} %F{cyan}%~%f${vcs_info_msg_0_} %(?.%F{green}❯.%F{red}❯)%f '
  RPROMPT=''
fi

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
[ -s "$BUN_INSTALL/_bun" ] && source "$BUN_INSTALL/_bun"
