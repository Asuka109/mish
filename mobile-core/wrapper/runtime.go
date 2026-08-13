package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/netip"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"github.com/metacubex/mihomo/adapter/outboundgroup"
	"github.com/metacubex/mihomo/component/dialer"
	"github.com/metacubex/mihomo/config"
	C "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/hub/executor"
	LC "github.com/metacubex/mihomo/listener/config"
	"github.com/metacubex/mihomo/listener/sing_tun"
	"github.com/metacubex/mihomo/tunnel"
	"github.com/metacubex/mihomo/tunnel/statistic"
)

var (
	wrapperRevision = "mish-mobile-core-v1"
	mihomoVersion   = "v1.19.29"
	mihomoCommit    = "e26714a181ac0e2fa803453c0a8e9a9ce94e31cb"
)

const (
	abiVersion       = 1
	maximumEvents    = 256
	maximumEventPoll = 128
	maximumItems     = 512
)

type coreStatus int32

const (
	statusOK coreStatus = iota
	statusInvalidArgument
	statusNotInitialized
	statusNotLoaded
	statusConfigRejected
	statusConflict
	statusLimitExceeded
	statusUnsupported
	statusFailure
)

func (status coreStatus) code() string {
	switch status {
	case statusOK:
		return "ok"
	case statusInvalidArgument:
		return "invalid-argument"
	case statusNotInitialized:
		return "not-initialized"
	case statusNotLoaded:
		return "not-loaded"
	case statusConfigRejected:
		return "config-rejected"
	case statusConflict:
		return "conflict"
	case statusLimitExceeded:
		return "limit-exceeded"
	case statusUnsupported:
		return "unsupported"
	default:
		return "core-failure"
	}
}

func (status coreStatus) message() string {
	switch status {
	case statusInvalidArgument:
		return "input is invalid"
	case statusNotInitialized:
		return "core is not initialized"
	case statusNotLoaded:
		return "no configuration is loaded"
	case statusConfigRejected:
		return "configuration was rejected"
	case statusConflict:
		return "operation conflicts with current state"
	case statusLimitExceeded:
		return "input exceeds the ABI limit"
	case statusUnsupported:
		return "operation is unsupported"
	case statusFailure:
		return "core operation failed"
	default:
		return "ok"
	}
}

type coreResult struct {
	status  coreStatus
	payload []byte
}

type responseEnvelope struct {
	ABIVersion int            `json:"abiVersion"`
	Data       any            `json:"data,omitempty"`
	Error      *errorEnvelope `json:"error,omitempty"`
}

type errorEnvelope struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func successResult(data any) coreResult {
	payload, err := json.Marshal(responseEnvelope{ABIVersion: abiVersion, Data: data})
	if err != nil {
		return failureResult(statusFailure, "response encoding failed")
	}
	return coreResult{status: statusOK, payload: payload}
}

func failureResult(status coreStatus, message string) coreResult {
	message = strings.TrimSpace(message)
	if message == "" {
		message = status.message()
	}
	if len(message) > 512 {
		message = message[:512]
	}
	payload, _ := json.Marshal(responseEnvelope{
		ABIVersion: abiVersion,
		Error:      &errorEnvelope{Code: status.code(), Message: message},
	})
	return coreResult{status: status, payload: payload}
}

type lifecyclePhase string

const (
	phaseInactive lifecyclePhase = "inactive"
	phaseRunning  lifecyclePhase = "running"
)

type coreEvent struct {
	Sequence string `json:"sequence"`
	Kind     string `json:"kind"`
	Session  string `json:"sessionId,omitempty"`
	Data     any    `json:"data,omitempty"`
}

type coreRuntime struct {
	mutex         sync.Mutex
	initialized   bool
	protect       func(int) error
	loaded        *config.Config
	configDigest  string
	listener      *sing_tun.Listener
	phase         lifecyclePhase
	session       string
	lifecycle     *lifecycleAuthority
	sequence      uint64
	events        []coreEvent
	routeCommands map[string]routeCommandRecord
	routeOrder    []string
}

var mobileCore = &coreRuntime{phase: phaseInactive}

type initializeRequest struct {
	ABIVersion int `json:"abiVersion"`
}

type lifecycleAuthority struct {
	MachineAuthority string `json:"machineAuthority"`
	ScopeEpoch       uint64 `json:"scopeEpoch"`
	OperationID      string `json:"operationId"`
	AdmittedRevision uint64 `json:"admittedRevision"`
	EffectIdentity   string `json:"effectIdentity"`
}

type startRequest struct {
	lifecycleAuthority
	SessionID         string   `json:"sessionId"`
	TunFileDescriptor int      `json:"tunFileDescriptor"`
	Stack             string   `json:"stack"`
	Addresses         []string `json:"addresses"`
	DNSHijack         []string `json:"dnsHijack"`
	MTU               uint32   `json:"mtu"`
}

type stopRequest struct {
	lifecycleAuthority
	SessionID string `json:"sessionId,omitempty"`
}

type snapshotRequest struct {
	Kind  string `json:"kind"`
	Limit int    `json:"limit,omitempty"`
}

type commandRequest struct {
	Operation        string `json:"operation"`
	OperationID      string `json:"operationId,omitempty"`
	RuntimeAuthority string `json:"runtimeAuthority,omitempty"`
	ProfileID        string `json:"profileId,omitempty"`
	ProfileRevision  string `json:"profileRevision,omitempty"`
	GroupID          string `json:"groupId,omitempty"`
	CurrentChildID   string `json:"currentChildId,omitempty"`
	ChildID          string `json:"childId,omitempty"`
	Mode             string `json:"mode,omitempty"`
	Group            string `json:"group,omitempty"`
	CurrentChild     string `json:"currentChild,omitempty"`
	Selection        string `json:"selection,omitempty"`
	ConnectionID     string `json:"connectionId,omitempty"`
}

type routeCommandRecord struct {
	RuntimeAuthority string
	ProfileID        string
	ProfileRevision  string
	GroupID          string
	CurrentChildID   string
	ChildID          string
	Group            string
	CurrentChild     string
	Selection        string
}

type pollEventsRequest struct {
	AfterSequence string `json:"afterSequence"`
	Limit         int    `json:"limit,omitempty"`
}

func decodeStrict(input []byte, output any) error {
	if len(input) == 0 {
		return errors.New("request must not be empty")
	}
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("request must contain one JSON value")
	}
	return nil
}

func (core *coreRuntime) initialize(input []byte, protect func(int) error) coreResult {
	var request initializeRequest
	if err := decodeStrict(input, &request); err != nil {
		return failureResult(statusInvalidArgument, "initialize request is invalid")
	}
	if request.ABIVersion != abiVersion {
		return failureResult(statusUnsupported, "requested ABI version is unsupported")
	}
	core.mutex.Lock()
	defer core.mutex.Unlock()
	if core.phase == phaseRunning {
		return failureResult(statusConflict, "platform callbacks cannot change while running")
	}
	core.initialized = true
	core.protect = protect
	return successResult(core.statusLocked())
}

func (core *coreRuntime) version() coreResult {
	return successResult(map[string]any{
		"abiVersion":      abiVersion,
		"goVersion":       runtime.Version(),
		"mihomoCommit":    mihomoCommit,
		"mihomoVersion":   mihomoVersion,
		"wrapperRevision": wrapperRevision,
	})
}

func validateRawConfig(raw *config.RawConfig) error {
	if raw.ExternalController != "" || raw.ExternalControllerTLS != "" ||
		raw.ExternalControllerUnix != "" || raw.ExternalControllerPipe != "" ||
		raw.ExternalDohServer != "" || raw.ExternalUI != "" {
		return errors.New("controller and external UI settings are forbidden")
	}
	if raw.Port != 0 || raw.SocksPort != 0 || raw.RedirPort != 0 || raw.TProxyPort != 0 ||
		raw.MixedPort != 0 || raw.ShadowSocksConfig != "" || raw.VmessConfig != "" ||
		raw.AllowLan || len(raw.Listeners) != 0 || len(raw.Tunnels) != 0 || raw.TuicServer.Enable {
		return errors.New("configuration-owned listeners are forbidden")
	}
	if raw.Tun.Enable || raw.Tun.FileDescriptor != 0 {
		return errors.New("TUN ownership must be supplied by the start request")
	}
	if raw.IPTables.Enable || raw.NTP.WriteToSystem {
		return errors.New("system mutation settings are forbidden")
	}
	if raw.GeoAutoUpdate {
		return errors.New("implicit geodata updates are forbidden")
	}
	for _, providers := range []map[string]map[string]any{raw.ProxyProvider, raw.RuleProvider} {
		for _, provider := range providers {
			if _, exists := provider["url"]; exists {
				return errors.New("remote provider URLs are forbidden")
			}
			if _, exists := provider["path"]; exists {
				return errors.New("provider filesystem paths are forbidden")
			}
		}
	}
	return nil
}

func parseConfig(input []byte) (*config.Config, string, error) {
	raw, err := config.UnmarshalRawConfig(input)
	if err != nil {
		return nil, "", err
	}
	if err := validateRawConfig(raw); err != nil {
		return nil, "", err
	}
	// The start DTO is the only TUN authority. Remove inactive upstream defaults
	// before exact Mihomo parsing so they cannot become active during apply.
	raw.Tun = config.RawTun{}
	parsed, err := config.ParseRawConfig(raw)
	if err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(input)
	return parsed, hex.EncodeToString(digest[:]), nil
}

func (core *coreRuntime) validateConfig(input []byte) coreResult {
	core.mutex.Lock()
	defer core.mutex.Unlock()
	if !core.initialized {
		return failureResult(statusNotInitialized, "core must be initialized before validation")
	}
	_, digest, err := parseConfig(input)
	if err != nil {
		return failureResult(statusConfigRejected, "configuration is invalid or violates the mobile boundary")
	}
	return successResult(map[string]any{"configSha256": digest, "valid": true})
}

func (core *coreRuntime) loadConfig(input []byte) coreResult {
	core.mutex.Lock()
	defer core.mutex.Unlock()
	if !core.initialized {
		return failureResult(statusNotInitialized, "core must be initialized before loading")
	}
	if core.phase == phaseRunning {
		return failureResult(statusConflict, "configuration cannot change while running")
	}
	parsed, digest, err := parseConfig(input)
	if err != nil {
		return failureResult(statusConfigRejected, "configuration is invalid or violates the mobile boundary")
	}
	core.loaded = parsed
	core.configDigest = digest
	core.routeCommands = nil
	core.routeOrder = nil
	core.publishLocked("configuration-loaded", map[string]any{"configSha256": digest})
	return successResult(core.statusLocked())
}

func validateStartRequest(request *startRequest) error {
	if err := validateLifecycleAuthority(&request.lifecycleAuthority); err != nil {
		return err
	}
	if len(request.SessionID) == 0 || len(request.SessionID) > 128 {
		return errors.New("sessionId must contain 1 to 128 bytes")
	}
	if request.TunFileDescriptor <= 0 {
		return errors.New("tunFileDescriptor must be positive")
	}
	stack, exists := C.StackTypeMapping[strings.ToLower(request.Stack)]
	if !exists || (stack != C.TunGvisor && stack != C.TunSystem && stack != C.TunMixed) {
		return errors.New("stack is unsupported")
	}
	if len(request.Addresses) == 0 || len(request.Addresses) > 8 || len(request.DNSHijack) > 8 {
		return errors.New("address or DNS list exceeds its bound")
	}
	if request.MTU < 1280 || request.MTU > 9000 {
		return errors.New("mtu must be between 1280 and 9000")
	}
	for _, address := range request.Addresses {
		if _, err := netip.ParsePrefix(address); err != nil {
			return errors.New("addresses must contain IP prefixes")
		}
	}
	for _, address := range request.DNSHijack {
		if _, _, err := net.SplitHostPort(address); err != nil {
			return errors.New("dnsHijack entries must contain host and port")
		}
	}
	return nil
}

func validLifecycleIdentifier(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if !((character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			character == '-' || character == '_' || character == '.') {
			return false
		}
	}
	return true
}

func validateLifecycleAuthority(authority *lifecycleAuthority) error {
	if authority == nil || !validLifecycleIdentifier(authority.MachineAuthority) ||
		authority.ScopeEpoch == 0 || !validLifecycleIdentifier(authority.OperationID) ||
		authority.AdmittedRevision == 0 || !validLifecycleIdentifier(authority.EffectIdentity) {
		return errors.New("lifecycle authority is invalid")
	}
	return nil
}

func sameLifecycleAuthority(left, right *lifecycleAuthority) bool {
	return left != nil && right != nil && *left == *right
}

func lifecycleSuccessor(candidate, current *lifecycleAuthority) bool {
	if current == nil {
		return true
	}
	if candidate.MachineAuthority != current.MachineAuthority {
		return false
	}
	if candidate.ScopeEpoch != current.ScopeEpoch {
		return candidate.ScopeEpoch > current.ScopeEpoch
	}
	if candidate.AdmittedRevision != current.AdmittedRevision {
		return candidate.AdmittedRevision > current.AdmittedRevision
	}
	currentEffect, err := strconv.ParseUint(current.EffectIdentity, 10, 64)
	if err != nil || currentEffect == ^uint64(0) {
		return false
	}
	return candidate.OperationID == current.OperationID &&
		candidate.EffectIdentity == strconv.FormatUint(currentEffect+1, 10)
}

func tunOptions(request *startRequest) LC.Tun {
	stack := C.StackTypeMapping[strings.ToLower(request.Stack)]
	options := LC.Tun{
		Enable:              true,
		Device:              "Mish",
		Stack:               stack,
		DNSHijack:           append([]string(nil), request.DNSHijack...),
		AutoRoute:           false,
		AutoDetectInterface: false,
		MTU:                 request.MTU,
		FileDescriptor:      request.TunFileDescriptor,
	}
	for _, address := range request.Addresses {
		prefix := netip.MustParsePrefix(address)
		if prefix.Addr().Is4() {
			options.Inet4Address = append(options.Inet4Address, prefix)
		} else {
			options.Inet6Address = append(options.Inet6Address, prefix)
		}
	}
	return options
}

func (core *coreRuntime) start(input []byte) coreResult {
	var request startRequest
	if err := decodeStrict(input, &request); err != nil || validateStartRequest(&request) != nil {
		return failureResult(statusInvalidArgument, "start request is invalid")
	}
	core.mutex.Lock()
	defer core.mutex.Unlock()
	if !core.initialized {
		return failureResult(statusNotInitialized, "core must be initialized before start")
	}
	if core.loaded == nil {
		return failureResult(statusNotLoaded, "configuration must be loaded before start")
	}
	if core.phase == phaseRunning {
		if core.session == request.SessionID &&
			sameLifecycleAuthority(&request.lifecycleAuthority, core.lifecycle) {
			return successResult(core.statusLocked())
		}
		return failureResult(statusConflict, "another session is already running")
	}
	if !lifecycleSuccessor(&request.lifecycleAuthority, core.lifecycle) {
		return failureResult(statusConflict, "lifecycle authority is stale")
	}
	authority := request.lifecycleAuthority
	core.lifecycle = &authority
	protect := core.protect
	dialer.DefaultSocketHook = func(_ string, _ string, connection syscall.RawConn) error {
		var protectError error
		if err := connection.Control(func(fileDescriptor uintptr) {
			protectError = protect(int(fileDescriptor))
		}); err != nil {
			return err
		}
		return protectError
	}
	executor.ApplyConfig(core.loaded, true)
	ownedTunFileDescriptor, err := syscall.Dup(request.TunFileDescriptor)
	if err != nil {
		dialer.DefaultSocketHook = nil
		executor.Shutdown()
		return failureResult(statusFailure, "platform TUN descriptor duplication failed")
	}
	syscall.CloseOnExec(ownedTunFileDescriptor)
	request.TunFileDescriptor = ownedTunFileDescriptor
	listener, err := sing_tun.New(tunOptions(&request), tunnel.Tunnel)
	if err != nil {
		_ = syscall.Close(ownedTunFileDescriptor)
		dialer.DefaultSocketHook = nil
		executor.Shutdown()
		return failureResult(statusFailure, "Mihomo rejected the platform TUN")
	}
	core.listener = listener
	core.phase = phaseRunning
	core.session = request.SessionID
	core.publishLocked("runtime-started", map[string]any{"mode": tunnel.Mode().String()})
	return successResult(core.statusLocked())
}

func (core *coreRuntime) stop(input []byte) coreResult {
	var request stopRequest
	if err := decodeStrict(input, &request); err != nil {
		return failureResult(statusInvalidArgument, "stop request is invalid")
	}
	if err := validateLifecycleAuthority(&request.lifecycleAuthority); err != nil {
		return failureResult(statusInvalidArgument, "stop lifecycle authority is invalid")
	}
	if request.SessionID != "" && !validLifecycleIdentifier(request.SessionID) {
		return failureResult(statusInvalidArgument, "sessionId exceeds its bound")
	}
	core.mutex.Lock()
	defer core.mutex.Unlock()
	if !core.initialized {
		return failureResult(statusNotInitialized, "core must be initialized before stop")
	}
	if core.phase == phaseInactive {
		if !sameLifecycleAuthority(&request.lifecycleAuthority, core.lifecycle) {
			if !lifecycleSuccessor(&request.lifecycleAuthority, core.lifecycle) {
				return failureResult(statusConflict, "lifecycle authority is stale")
			}
			authority := request.lifecycleAuthority
			core.lifecycle = &authority
		}
		return successResult(core.statusLocked())
	}
	if request.SessionID != "" && request.SessionID != core.session {
		return failureResult(statusConflict, "sessionId does not own the running Core")
	}
	if !lifecycleSuccessor(&request.lifecycleAuthority, core.lifecycle) {
		return failureResult(statusConflict, "lifecycle authority is stale")
	}
	authority := request.lifecycleAuthority
	core.lifecycle = &authority
	stoppedSession := core.session
	if core.listener != nil {
		_ = core.listener.Close()
		core.listener = nil
	}
	dialer.DefaultSocketHook = nil
	executor.Shutdown()
	core.phase = phaseInactive
	core.session = ""
	core.publishLocked("runtime-stopped", map[string]any{"sessionId": stoppedSession})
	return successResult(core.statusLocked())
}

func (core *coreRuntime) statusLocked() map[string]any {
	mode := tunnel.Mode()
	if core.phase == phaseInactive && core.loaded != nil {
		mode = core.loaded.General.Mode
	}
	return map[string]any{
		"configSha256":  optionalString(core.configDigest),
		"eventSequence": strconv.FormatUint(core.sequence, 10),
		"loaded":        core.loaded != nil,
		"mode":          mode.String(),
		"phase":         core.phase,
		"sessionId":     optionalString(core.session),
	}
}

func optionalString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func boundedLimit(limit int) (int, error) {
	if limit == 0 {
		return 128, nil
	}
	if limit < 1 || limit > maximumItems {
		return 0, errors.New("limit is outside the supported range")
	}
	return limit, nil
}

func (core *coreRuntime) snapshot(input []byte) coreResult {
	var request snapshotRequest
	if err := decodeStrict(input, &request); err != nil {
		return failureResult(statusInvalidArgument, "snapshot request is invalid")
	}
	limit, err := boundedLimit(request.Limit)
	if err != nil {
		return failureResult(statusLimitExceeded, err.Error())
	}
	core.mutex.Lock()
	defer core.mutex.Unlock()
	if !core.initialized {
		return failureResult(statusNotInitialized, "core must be initialized before snapshots")
	}
	switch request.Kind {
	case "status":
		return successResult(core.statusLocked())
	case "routes":
		if core.loaded == nil {
			return failureResult(statusNotLoaded, "no configuration is loaded")
		}
		proxies := tunnel.Proxies()
		mode := tunnel.Mode()
		if core.phase == phaseInactive {
			proxies = core.loaded.Proxies
			mode = core.loaded.General.Mode
		}
		return successResult(routesSnapshot(limit, proxies, mode.String()))
	case "traffic":
		return successResult(trafficSnapshot())
	case "connections":
		return successResult(connectionsSnapshot(limit))
	default:
		return failureResult(statusUnsupported, "snapshot kind is unsupported")
	}
}

type routeGroupSnapshot struct {
	Name       string   `json:"name"`
	Selected   string   `json:"selected"`
	Candidates []string `json:"candidates"`
}

func routesSnapshot(limit int, proxies map[string]C.Proxy, mode string) map[string]any {
	names := make([]string, 0, len(proxies))
	for name := range proxies {
		names = append(names, name)
	}
	sort.Strings(names)
	groups := make([]routeGroupSnapshot, 0, min(limit, len(names)))
	for _, name := range names {
		group, ok := proxies[name].Adapter().(outboundgroup.ProxyGroup)
		if !ok {
			continue
		}
		candidates := make([]string, 0, len(group.Proxies()))
		for _, candidate := range group.Proxies() {
			candidates = append(candidates, candidate.Name())
		}
		if len(candidates) > limit {
			candidates = candidates[:limit]
		}
		groups = append(groups, routeGroupSnapshot{Name: name, Selected: group.Now(), Candidates: candidates})
		if len(groups) == limit {
			break
		}
	}
	return map[string]any{"groups": groups, "mode": mode, "truncated": len(groups) == limit && len(names) > limit}
}

func trafficSnapshot() map[string]any {
	uploadRate, downloadRate := statistic.DefaultManager.Now()
	uploadTotal, downloadTotal := statistic.DefaultManager.Total()
	return map[string]any{
		"downloadBytesPerSecond": strconv.FormatInt(downloadRate, 10),
		"downloadTotalBytes":     strconv.FormatInt(downloadTotal, 10),
		"memoryBytes":            strconv.FormatUint(statistic.DefaultManager.Memory(), 10),
		"uploadBytesPerSecond":   strconv.FormatInt(uploadRate, 10),
		"uploadTotalBytes":       strconv.FormatInt(uploadTotal, 10),
	}
}

type connectionSnapshot struct {
	ID       string `json:"id"`
	Network  string `json:"network"`
	Host     string `json:"host"`
	Rule     string `json:"rule"`
	Upload   string `json:"uploadBytes"`
	Download string `json:"downloadBytes"`
}

func connectionsSnapshot(limit int) map[string]any {
	connections := make([]connectionSnapshot, 0, limit)
	total := 0
	statistic.DefaultManager.Range(func(tracker statistic.Tracker) bool {
		total++
		if len(connections) >= limit {
			return true
		}
		info := tracker.Info()
		host := info.Metadata.Host
		if host == "" {
			host = info.Metadata.DstIP.String()
		}
		connections = append(connections, connectionSnapshot{
			ID: tracker.ID(), Network: info.Metadata.NetWork.String(), Host: host, Rule: info.Rule,
			Upload:   strconv.FormatInt(info.UploadTotal.Load(), 10),
			Download: strconv.FormatInt(info.DownloadTotal.Load(), 10),
		})
		return true
	})
	sort.Slice(connections, func(left, right int) bool { return connections[left].ID < connections[right].ID })
	return map[string]any{"connections": connections, "truncated": total > len(connections)}
}

func (core *coreRuntime) command(input []byte) coreResult {
	var request commandRequest
	if err := decodeStrict(input, &request); err != nil {
		return failureResult(statusInvalidArgument, "command request is invalid")
	}
	core.mutex.Lock()
	defer core.mutex.Unlock()
	if !core.initialized {
		return failureResult(statusNotInitialized, "core must be initialized before commands")
	}
	if core.phase != phaseRunning {
		return failureResult(statusConflict, "commands require a running Core")
	}
	switch request.Operation {
	case "set-routing-mode":
		mode, exists := tunnel.ModeMapping[strings.ToLower(request.Mode)]
		if !exists {
			return failureResult(statusInvalidArgument, "routing mode is invalid")
		}
		tunnel.SetMode(mode)
		core.publishLocked("routing-mode-changed", map[string]any{"mode": mode.String()})
	case "select-policy":
		if len(request.OperationID) == 0 || len(request.OperationID) > 128 ||
			len(request.RuntimeAuthority) == 0 || len(request.RuntimeAuthority) > 128 ||
			len(request.ProfileID) == 0 || len(request.ProfileID) > 128 ||
			len(request.ProfileRevision) == 0 || len(request.ProfileRevision) > 128 ||
			len(request.GroupID) == 0 || len(request.GroupID) > 128 ||
			len(request.CurrentChildID) == 0 || len(request.CurrentChildID) > 128 ||
			len(request.ChildID) == 0 || len(request.ChildID) > 128 ||
			len(request.Group) == 0 || len(request.Group) > 256 ||
			len(request.CurrentChild) == 0 || len(request.CurrentChild) > 256 ||
			len(request.Selection) == 0 || len(request.Selection) > 256 {
			return failureResult(statusInvalidArgument, "policy selection is invalid")
		}
		if core.lifecycle == nil || request.RuntimeAuthority != core.lifecycle.MachineAuthority {
			return failureResult(statusConflict, "runtime authority is stale")
		}
		record := routeCommandRecord{
			RuntimeAuthority: request.RuntimeAuthority,
			ProfileID:        request.ProfileID, ProfileRevision: request.ProfileRevision,
			GroupID: request.GroupID, CurrentChildID: request.CurrentChildID, ChildID: request.ChildID,
			Group: request.Group, CurrentChild: request.CurrentChild, Selection: request.Selection,
		}
		if previous, exists := core.routeCommands[request.OperationID]; exists {
			if previous == record {
				return successResult(core.statusLocked())
			}
			return failureResult(statusConflict, "operation identity conflicts with a prior command")
		}
		proxy, exists := tunnel.Proxies()[request.Group]
		if !exists {
			return failureResult(statusInvalidArgument, "policy group was not found")
		}
		group, grouped := proxy.Adapter().(outboundgroup.ProxyGroup)
		selector, selectable := proxy.Adapter().(outboundgroup.SelectAble)
		if !grouped || !selectable {
			return failureResult(statusInvalidArgument, "policy group is not selectable")
		}
		if group.Now() != request.CurrentChild {
			return failureResult(statusConflict, "current policy child is stale")
		}
		if err := selector.Set(request.Selection); err != nil {
			return failureResult(statusInvalidArgument, "policy child is not a current member")
		}
		if core.routeCommands == nil {
			core.routeCommands = make(map[string]routeCommandRecord)
		}
		core.routeCommands[request.OperationID] = record
		core.routeOrder = append(core.routeOrder, request.OperationID)
		if len(core.routeOrder) > 32 {
			delete(core.routeCommands, core.routeOrder[0])
			core.routeOrder = core.routeOrder[1:]
		}
		core.publishLocked("policy-selected", map[string]any{"group": request.Group, "selection": request.Selection})
	case "close-connection":
		if len(request.ConnectionID) == 0 || len(request.ConnectionID) > 128 {
			return failureResult(statusInvalidArgument, "connectionId is invalid")
		}
		connection := statistic.DefaultManager.Get(request.ConnectionID)
		if connection == nil {
			return failureResult(statusInvalidArgument, "connection was not found")
		}
		if err := connection.Close(); err != nil {
			return failureResult(statusFailure, "connection close failed")
		}
		core.publishLocked("connection-closed", map[string]any{"connectionId": request.ConnectionID})
	case "close-all-connections":
		closed := 0
		statistic.DefaultManager.Range(func(connection statistic.Tracker) bool {
			if connection.Close() == nil {
				closed++
			}
			return true
		})
		core.publishLocked("connections-closed", map[string]any{"count": closed})
	default:
		return failureResult(statusUnsupported, "command operation is unsupported")
	}
	return successResult(core.statusLocked())
}

func (core *coreRuntime) publishLocked(kind string, data any) {
	core.sequence++
	core.events = append(core.events, coreEvent{
		Sequence: strconv.FormatUint(core.sequence, 10),
		Kind:     kind,
		Session:  core.session,
		Data:     data,
	})
	if len(core.events) > maximumEvents {
		core.events = append([]coreEvent(nil), core.events[len(core.events)-maximumEvents:]...)
	}
}

func (core *coreRuntime) pollEvents(input []byte) coreResult {
	var request pollEventsRequest
	if err := decodeStrict(input, &request); err != nil {
		return failureResult(statusInvalidArgument, "event request is invalid")
	}
	after, err := strconv.ParseUint(request.AfterSequence, 10, 64)
	if err != nil {
		return failureResult(statusInvalidArgument, "afterSequence must be an unsigned decimal string")
	}
	limit := request.Limit
	if limit == 0 {
		limit = 64
	}
	if limit < 1 || limit > maximumEventPoll {
		return failureResult(statusLimitExceeded, "event limit exceeds its bound")
	}
	core.mutex.Lock()
	defer core.mutex.Unlock()
	if !core.initialized {
		return failureResult(statusNotInitialized, "core must be initialized before events")
	}
	events := make([]coreEvent, 0, limit)
	for _, event := range core.events {
		sequence, _ := strconv.ParseUint(event.Sequence, 10, 64)
		if sequence <= after {
			continue
		}
		events = append(events, event)
		if len(events) == limit {
			break
		}
	}
	oldest := "0"
	gap := false
	if len(core.events) > 0 {
		oldest = core.events[0].Sequence
		oldestSequence, _ := strconv.ParseUint(oldest, 10, 64)
		gap = after < oldestSequence && oldestSequence-after > 1
	}
	return successResult(map[string]any{
		"events":         events,
		"gap":            gap,
		"latestSequence": strconv.FormatUint(core.sequence, 10),
		"oldestSequence": oldest,
	})
}

func init() {
	C.Version = mihomoVersion
}
