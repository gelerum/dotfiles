FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 IN_CONTAINER=1

# Инструменты
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git less unzip build-essential \
      zsh stow ripgrep fd-find eza bat zoxide \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && ln -s /usr/bin/batcat /usr/local/bin/bat

# Neovim (последний стабильный релиз)
RUN mkdir /opt/nvim \
 && curl -fsSL "https://github.com/neovim/neovim/releases/latest/download/nvim-linux-$(uname -m | sed s/aarch64/arm64/).tar.gz" \
    | tar -xz -C /opt/nvim --strip-components=1 \
 && ln -s /opt/nvim/bin/nvim /usr/local/bin/nvim

# Starship
RUN curl -fsSL https://starship.rs/install.sh | sh -s -- -y

# Пользователь с вашим UID/GID из .env
ARG UID
ARG GID
RUN userdel -r ubuntu \
 && groupadd -g "$GID" q \
 && useradd -m -u "$UID" -g q -s /usr/bin/zsh q

# Claude Code
USER q
ENV PATH=/home/q/.local/bin:$PATH
RUN mkdir -p ~/.claude/projects ~/.local/share/nvim \
 && curl -fsSL https://claude.ai/install.sh | bash

# Dotfiles: клон принадлежит q — изменения возможны только внутри контейнера,
# в репозиторий они не попадут, пересборка всё восстановит
USER root
ARG DOTFILES_REPO
ARG DOTFILES_REF
RUN git clone --depth 1 "$DOTFILES_REPO.git" /opt/dotfiles \
 && chown -R q:q /opt/dotfiles \
 && install -d -o q -g q /work \
 && if [ -f /opt/dotfiles/container/claude-managed-settings.json ]; then \
      install -Dm644 /opt/dotfiles/container/claude-managed-settings.json /etc/claude-code/managed-settings.json; \
    fi

# Конфиги через stow. ~/.config создаём заранее, иначе stow заменит его целиком одной ссылкой
USER q
ARG DOTFILES_PACKAGES
RUN mkdir -p ~/.config \
 && cd /opt/dotfiles && stow -t ~ $DOTFILES_PACKAGES

# Плагины Neovim — ровно те версии, что в lazy-lock.json
RUN nvim --headless "+Lazy! restore" +qa
# Если используете mason-tool-installer, раскомментируйте:
# RUN nvim --headless "+MasonToolsInstallSync" +qa

WORKDIR /work
CMD ["sleep", "infinity"]
