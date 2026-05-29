# faustcode-mcp — local build helpers.
#
# The contract `tools.json` is the single source of truth at the repo root.
# A local copy under mcp/ is required so that //go:embed can compile it
# into the binary. `make sync-contract` keeps the two in sync.

.PHONY: all sync-contract build probe test clean

all: build

sync-contract:
	@cp ../tools.json tools.json
	@echo "synced ../tools.json -> tools.json"

build: sync-contract
	@go build -o faustcode-mcp .
	@ls -lh faustcode-mcp

probe: sync-contract
	@go build -o e2e-probe ./cmd/e2e-probe/
	@ls -lh e2e-probe

test: sync-contract
	@go test ./...

clean:
	@rm -f faustcode-mcp e2e-probe tools.json
	@echo "cleaned"
