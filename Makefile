# rave — synchronized peer-to-peer audio rooms
.DEFAULT_GOAL := help
SHELL := /bin/bash

COMPOSE     := docker compose
DEV_COMPOSE := $(COMPOSE) -f docker-compose.yml -f docker-compose.dev.yml

# LAN IP of this host. Phones join over this, so it must be the wifi address,
# not loopback. Linux falls back to `hostname -I`.
LAN_IP := $(shell ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $$1}')

.PHONY: help dev up down build logs lan ca lint typecheck test metrics clean install

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install workspace dependencies
	pnpm install

dev: ## Start the dev stack with hot reload
	RAVE_HOST=$(LAN_IP) $(DEV_COMPOSE) up --build

up: ## Start the production stack
	RAVE_HOST=$(LAN_IP) $(COMPOSE) up -d --build
	@$(MAKE) --no-print-directory lan

down: ## Stop the stack
	$(COMPOSE) down

build: ## Build all production images
	$(COMPOSE) build

logs: ## Tail logs from all services
	$(COMPOSE) logs -f

lan: ## Print the LAN HTTPS URL and a QR code for phones
	@if [ -z "$(LAN_IP)" ]; then echo "Could not determine LAN IP."; exit 1; fi
	@echo ""
	@echo "  rave:  https://$(LAN_IP)"
	@echo ""
	@node -e "require('qrcode-terminal').generate('https://$(LAN_IP)',{small:true},c=>console.log(c))" 2>/dev/null \
		|| qrencode -t ANSIUTF8 "https://$(LAN_IP)" 2>/dev/null \
		|| echo "  (run 'make install' for a scannable QR code)"
	@echo "  First visit on each device shows a cert warning — run 'make ca' and"
	@echo "  trust the certificate. iOS also needs Settings > General > About >"
	@echo "  Certificate Trust Settings."
	@echo ""

ca: ## Export Caddy's root CA for device trust
	@$(COMPOSE) cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root-ca.crt \
		&& echo "Wrote caddy-root-ca.crt — install and trust this on each device." \
		|| echo "Could not read the CA. Is the stack running? Try 'make dev' first."

lint: ## Lint every package
	pnpm -r --no-bail lint

typecheck: ## Typecheck every package
	pnpm --filter @rave/protocol build
	pnpm -r --no-bail typecheck

test: ## Run every test suite
	pnpm -r --no-bail test

metrics: ## Open the Grafana dashboard
	@open $(DASHBOARD_URL) 2>/dev/null || xdg-open $(DASHBOARD_URL) 2>/dev/null || echo "Grafana: $(DASHBOARD_URL)"

clean: ## Tear down containers, volumes and build artifacts
	$(COMPOSE) down -v --remove-orphans
	rm -rf apps/web/.next apps/*/dist packages/*/dist caddy-root-ca.crt
