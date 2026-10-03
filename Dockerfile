FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 IN_CONTAINER=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git less unzip build-essential \
      zsh stow ripgrep fd-find \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd

# Neovim
RUN mkdir /opt/nvim \
 && curl -fsSL "https://github.com/neovim/neovim/releases/latest/download/nvim-linux-$(uname -m | sed s/aarch64/arm64/).tar.gz" \
    | tar -xz -C /opt/nvim --strip-components=1 \
 && ln -s /opt/nvim/bin/nvim /usr/local/bin/nvim

# Starship
RUN curl -fsSL https://starship.rs/install.sh | sh -s -- -y

# Пользователь с заданным UID/GID
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

USER root
ARG DOTFILES_REPO
ARG DOTFILES_REF
RUN git clone --depth 1 "$DOTFILES_REPO.git" /opt/dotfiles \
 && chown -R q:q /opt/dotfiles \
 && if [ -f /opt/dotfiles/container/claude-managed-settings.json ]; then \
      install -Dm644 /opt/dotfiles/container/claude-managed-settings.json /etc/claude-code/managed-settings.json; \
    fi

USER q
ARG DOTFILES_PACKAGES
RUN mkdir -p ~/.config \
 && cd /opt/dotfiles && stow -t ~ $DOTFILES_PACKAGES

RUN nvim --headless "+Lazy! restore" +qa
# Если используете mason-tool-installer, раскомментируйте:
# RUN nvim --headless "+MasonToolsInstallSync" +qa

WORKDIR /work
CMD ["sleep", "infinity"]
