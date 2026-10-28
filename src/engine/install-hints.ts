/**
 * 명령을 설치하는 방법을 알려주는 정적 표.
 *
 * ## 왜 표인가
 *
 * 명령 이름에서 패키지 이름을 **추측하지 않는다.** `helm` 의 패키지가 `helm` 이라고
 * 가정하면 `kubectl` 에서도 `k8s-client` 가 아니라 `kubectl` 이라고 말하게 된다.
 * 표에 없는 명령은 설치 지시 없이 "이 호스트에 없다" 만 알린다.
 * 없는 정보를 지어내면 그건 안내가 아니라 오답이다.
 *
 * ## 여러 패키지 관리자
 *
 * 리눅스는 배포판마다 관리자가 다르다(apt / dnf / yum / pacman / apk). 이 표는
 * 후보를 순서대로 나열하고, 호출하는 쪽이 **그 관리자 바이너리가 이 호스트에 있는지
 * 조회해서** 첫 번째 사용 가능한 것을 고른다. `/etc/os-release` 을 읽지 않는다 —
 * 읽을 이유가 없고, 허용 경로 밖 읽기는 경계를 흐린다.
 *
 * ## 관리자마다 패키지 이름이 다르다
 *
 * `kubectl` 의 apt 패키지명은 `kubernetes-client` 이고 dnf/yum 에서는 `kubectl` 이다.
 * 그래서 패키지 이름은 **관리자별로** 적는다. 도구 이름 하나를 모든 관리자에 그대로
 * 적용하면 안 되는 이유가 이것이다.
 *
 * ## 표에 없는 것은 없는 것이다
 *
 * `helm` 은 npm 패키지로 설치되지 않는다(npm 의 `helm` 패키지는 버전 0.2.1 의 무관한
 * 도구다). 공식 설치 스크립트는 셸 파이프라인이라 안내하지 않는다.
 * 없는 방법을 지어내지 않으려면 항목이 비어 있어야 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

/** 패키지 관리자. */
export type InstallManager =
  | "brew" | "apt" | "dnf" | "yum" | "pacman" | "apk"
  | "choco" | "winget" | "scoop" | "npm";

/** 한 관리자로 설치하는 방법. */
export interface InstallManagerCommand {
  /** 실제로 실행할 명령. */
  command: string;
  /** 그 명령이 설치하는 패키지 이름. */
  package: string;
}

/** 한 명령의 설치 방법. */
export interface InstallHint {
  /** 관리자별 설치 방법. 없는 관리자는 키가 없다. */
  managers: Partial<Record<InstallManager, InstallManagerCommand>>;
}

/**
 * 플랫폼별 관리자 후보 순서.
 *
 * 순서는 "가장 흔한 것 먼저" 다. 같은 키가 여러 번 나오면 앞의 것이 이긴다.
 * Linux 의 순서는 배포판 가설이 아니라 **그 배포판의 관리자가 이미 설치돼 있는지** 로
 * 최종 결정된다.
 *
 * `npm` 은 마지막 후보다. 시스템 패키지 관리자로는 파이썬·루비·node 패키지가 없거나
 * 이름이 다르고, `npm install -g` 가 그 자리에 선다. 다른 관리자가 있으면 그쪽이 먼저다.
 */
export const MANAGER_CANDIDATES: Partial<Record<NodeJS.Platform, InstallManager[]>> = {
  darwin: ["brew", "npm"],
  linux:  ["apt", "dnf", "yum", "pacman", "apk", "npm"],
  win32:  ["winget", "choco", "scoop"],
};

/**
 * 설치 방법 표.
 *
 * 등록 대상은 parism 의 기본 allowlist 에 있는 명령 가운데 "이 호스트에 없을 수 있는"
 * 명령이다. 어디에나 있는 `ls`·`cat`·`grep` 은 넣지 않았다 — 없는 일이 아니라면
 * 이 표는 하얀 소음을 만든다.
 *
 * `apt` 와 `brew` 는 **자신으로 설치되지 않는다.** 자기 자신을 설치하도록 안내하면
 * 안내를 읽는 쪽이 곧바로 실패한다. 그래서 표에 넣지 않는다.
 *
 * 패키지 이름은 이 호스트의 `apt-cache` 로 확인한 것이다(2026-10-22, Ubuntu 24.04).
 * 확인하지 못한 관리자(dnf/yum/pacman/apk/brew/choco/winget)는 배포판 저장소 기준으로
 * 적었고, 그쪽은 이 호스트에서 검증할 수 없다.
 */
export const INSTALL_HINTS: Record<string, InstallHint> = {
  helm: {
    managers: {
      brew:   { command: "brew install helm",         package: "helm" },
      choco:  { command: "choco install kubernetes-helm", package: "kubernetes-helm" },
      winget: { command: "winget install Helm.Helm",  package: "Helm.Helm" },
    },
  },
  kubectl: {
    managers: {
      brew:   { command: "brew install kubernetes-client", package: "kubernetes-client" },
      /** apt 에는 `kubectl` 이라는 패키지가 없다. 실제 이름은 kubernetes-client 다. */
      apt:    { command: "apt install -y kubernetes-client", package: "kubernetes-client" },
      dnf:    { command: "dnf install -y kubectl",      package: "kubectl" },
      yum:    { command: "yum install -y kubectl",      package: "kubectl" },
      pacman: { command: "pacman -S kubernetes-cli",    package: "kubernetes-cli" },
      choco:  { command: "choco install kubernetes-cli", package: "kubernetes-cli" },
      winget: { command: "winget install Kubernetes.kubectl", package: "Kubernetes.kubectl" },
    },
  },
  terraform: {
    managers: {
      brew:   { command: "brew install terraform", package: "terraform" },
      dnf:    { command: "dnf install -y terraform", package: "terraform" },
      yum:    { command: "yum install -y terraform", package: "terraform" },
      pacman: { command: "pacman -S terraform",   package: "terraform" },
      choco:  { command: "choco install terraform", package: "terraform" },
      winget: { command: "winget install Hashicorp.Terraform", package: "Hashicorp.Terraform" },
    },
  },
  docker: {
    managers: {
      brew:   { command: "brew install --cask docker", package: "docker" },
      apt:    { command: "apt install -y docker.io",  package: "docker.io" },
      dnf:    { command: "dnf install -y docker",      package: "docker" },
      yum:    { command: "yum install -y docker",      package: "docker" },
      pacman: { command: "pacman -S docker",          package: "docker" },
      apk:    { command: "apk add docker",            package: "docker" },
      choco:  { command: "choco install docker-cli",  package: "docker-cli" },
      winget: { command: "winget install Docker.DockerDesktop", package: "Docker.DockerDesktop" },
    },
  },
  gh: {
    managers: {
      brew:   { command: "brew install gh",   package: "gh" },
      apt:    { command: "apt install -y gh", package: "gh" },
      dnf:    { command: "dnf install -y gh", package: "gh" },
      yum:    { command: "yum install -y gh", package: "gh" },
      pacman: { command: "pacman -S github-cli", package: "github-cli" },
      apk:    { command: "apk add gh",       package: "gh" },
      choco:  { command: "choco install gh", package: "gh" },
      winget: { command: "winget install GitHub.cli", package: "GitHub.cli" },
    },
  },
  cargo: {
    managers: {
      brew:   { command: "brew install rustup-init", package: "rustup-init" },
      apt:    { command: "apt install -y cargo",    package: "cargo" },
      dnf:    { command: "dnf install -y cargo",    package: "cargo" },
      yum:    { command: "yum install -y cargo",    package: "cargo" },
      pacman: { command: "pacman -S rustup",        package: "rustup" },
      apk:    { command: "apk add rust cargo",      package: "rust cargo" },
      choco:  { command: "choco install rustup.install", package: "rustup.install" },
      winget: { command: "winget install Rustlang.Rustup", package: "Rustlang.Rustup" },
    },
  },
  npm: {
    managers: {
      brew:   { command: "brew install node",   package: "node" },
      apt:    { command: "apt install -y nodejs", package: "nodejs" },
      dnf:    { command: "dnf install -y nodejs", package: "nodejs" },
      yum:    { command: "yum install -y nodejs", package: "nodejs" },
      pacman: { command: "pacman -S nodejs",   package: "nodejs" },
      apk:    { command: "apk add nodejs",     package: "nodejs" },
      choco:  { command: "choco install nodejs", package: "nodejs" },
      winget: { command: "winget install OpenJS.NodeJS", package: "OpenJS.NodeJS" },
    },
  },
  pnpm: {
    managers: {
      brew:   { command: "brew install pnpm",   package: "pnpm" },
      apk:    { command: "apk add pnpm",        package: "pnpm" },
      choco:  { command: "choco install pnpm",  package: "pnpm" },
      winget: { command: "winget install pnpm.pnpm", package: "pnpm.pnpm" },
      npm:    { command: "npm install -g pnpm", package: "pnpm" },
    },
  },
  tree: {
    managers: {
      brew:   { command: "brew install tree",   package: "tree" },
      apt:    { command: "apt install -y tree", package: "tree" },
      dnf:    { command: "dnf install -y tree", package: "tree" },
      yum:    { command: "yum install -y tree", package: "tree" },
      pacman: { command: "pacman -S tree",     package: "tree" },
      apk:    { command: "apk add tree",       package: "tree" },
      choco:  { command: "choco install tree", package: "tree" },
      winget: { command: "winget install BurntSushi.tree", package: "BurntSushi.tree" },
    },
  },
  lsof: {
    managers: {
      brew:   { command: "brew install lsof",   package: "lsof" },
      apt:    { command: "apt install -y lsof", package: "lsof" },
      dnf:    { command: "dnf install -y lsof", package: "lsof" },
      yum:    { command: "yum install -y lsof", package: "lsof" },
      pacman: { command: "pacman -S lsof",     package: "lsof" },
      apk:    { command: "apk add lsof",       package: "lsof" },
      choco:  { command: "choco install lsof", package: "lsof" },
    },
  },
  ss: {
    managers: {
      apt:    { command: "apt install -y iproute2", package: "iproute2" },
      dnf:    { command: "dnf install -y iproute",  package: "iproute" },
      yum:    { command: "yum install -y iproute",  package: "iproute" },
      pacman: { command: "pacman -S iproute2",      package: "iproute2" },
      apk:    { command: "apk add iproute2",        package: "iproute2" },
    },
  },
  dig: {
    managers: {
      brew:   { command: "brew install bind",     package: "bind" },
      apt:    { command: "apt install -y dnsutils", package: "dnsutils" },
      dnf:    { command: "dnf install -y bind-utils", package: "bind-utils" },
      yum:    { command: "yum install -y bind-utils", package: "bind-utils" },
      pacman: { command: "pacman -S bind",        package: "bind" },
      apk:    { command: "apk add bind-tools",    package: "bind-tools" },
      choco:  { command: "choco install bind-toolsonly", package: "bind-toolsonly" },
    },
  },
  netstat: {
    managers: {
      brew:   { command: "brew install net-tools",   package: "net-tools" },
      apt:    { command: "apt install -y net-tools", package: "net-tools" },
      dnf:    { command: "dnf install -y net-tools", package: "net-tools" },
      yum:    { command: "yum install -y net-tools", package: "net-tools" },
      pacman: { command: "pacman -S net-tools",      package: "net-tools" },
      apk:    { command: "apk add net-tools",        package: "net-tools" },
      choco:  { command: "choco install net-tools",  package: "net-tools" },
    },
  },
  ping: {
    managers: {
      brew:   { command: "brew install iputils",     package: "iputils" },
      apt:    { command: "apt install -y iputils-ping", package: "iputils-ping" },
      dnf:    { command: "dnf install -y iputils",    package: "iputils" },
      yum:    { command: "yum install -y iputils",    package: "iputils" },
      pacman: { command: "pacman -S iputils",         package: "iputils" },
      apk:    { command: "apk add iputils",           package: "iputils" },
      choco:  { command: "choco install iputils",     package: "iputils" },
    },
  },
  curl: {
    managers: {
      brew:   { command: "brew install curl",   package: "curl" },
      apt:    { command: "apt install -y curl", package: "curl" },
      dnf:    { command: "dnf install -y curl", package: "curl" },
      yum:    { command: "yum install -y curl", package: "curl" },
      pacman: { command: "pacman -S curl",     package: "curl" },
      apk:    { command: "apk add curl",       package: "curl" },
      choco:  { command: "choco install curl", package: "curl" },
      winget: { command: "winget install cURL.CURL", package: "cURL.CURL" },
    },
  },
  systemctl: {
    managers: {
      apt:    { command: "apt install -y systemd", package: "systemd" },
      dnf:    { command: "dnf install -y systemd", package: "systemd" },
      yum:    { command: "yum install -y systemd", package: "systemd" },
      pacman: { command: "pacman -S systemd",      package: "systemd" },
      apk:    { command: "apk add systemd",        package: "systemd" },
    },
  },
  journalctl: {
    managers: {
      apt:    { command: "apt install -y systemd", package: "systemd" },
      dnf:    { command: "dnf install -y systemd", package: "systemd" },
      yum:    { command: "yum install -y systemd", package: "systemd" },
      pacman: { command: "pacman -S systemd",      package: "systemd" },
      apk:    { command: "apk add systemd",        package: "systemd" },
    },
  },
};

/**
 * 이 플랫폼에서 쓸 수 있는 설치 명령을 고른다.
 *
 * @param cmd                 명령 이름
 * @param platform            대상 플랫폼
 * @param isManagerAvailable  그 관리자 바이너리가 이 호스트에 있는지 확인하는 함수.
 *                             생략하면 후보 순서상 첫 번째를 쓴다.
 * @returns 설치 명령이 있으면 `{ command, package, manager }`, 없으면 undefined.
 */
export function resolveInstallHint(
  cmd:        string,
  platform:   NodeJS.Platform,
  isManagerAvailable?: (manager: InstallManager) => boolean,
): { command: string; package: string; manager: InstallManager } | undefined {
  const hint = INSTALL_HINTS[cmd];
  if (!hint) return undefined;

  for (const manager of MANAGER_CANDIDATES[platform] ?? []) {
    const entry = hint.managers[manager];
    if (!entry) continue;
    if (isManagerAvailable && !isManagerAvailable(manager)) continue;
    return { command: entry.command, package: entry.package, manager };
  }
  return undefined;
}
