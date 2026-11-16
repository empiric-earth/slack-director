PREFIX ?= $(HOME)/.config/opencode
PLUGIN_DIR := $(PREFIX)/plugins/slack-director
AGENT_FILE := $(PREFIX)/agents/slack-director.md
# A skill folder in the config directory wins over a plugin's skill of the same
# id, silently, so a copy left there shadows the one this plugin serves.
STALE_SKILL_DIR := $(PREFIX)/skills/slack-director

.PHONY: test install uninstall

test:
	node --test --test-reporter=tap test/*.test.js

install:
	mkdir -p "$(PLUGIN_DIR)" "$(PREFIX)/agents"
	cp index.js package.json "$(PLUGIN_DIR)/"
	rm -rf "$(PLUGIN_DIR)/skills"
	cp -R skills "$(PLUGIN_DIR)/skills"
	cp agents/slack-director.md "$(AGENT_FILE)"
	rm -rf "$(STALE_SKILL_DIR)"
	@echo "Installed. Run 'opencode reload' to load the slack-director agent, its skill and its command."

uninstall:
	rm -rf "$(PLUGIN_DIR)"
	rm -f "$(AGENT_FILE)"
	@echo "Uninstalled. Removed only the slack-director plugin directory and agents/slack-director.md."
