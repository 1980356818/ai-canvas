import json
import os
import sys
from typing import Optional


def _exe_dir() -> str:
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _looks_like_ai_canvas_root(d: str) -> bool:
    """True if *d* contains ai-canvas/ (i.e. is the AI无限画布 root)."""
    return os.path.isdir(os.path.join(d, "ai-canvas"))


def _project_base_dir() -> str:
    """返回 AI无限画布 根目录。

    兼容两种 exe 部署位置:
        AI无限画布/dist/exe                      -> base = AI无限画布/
        AI无限画布/AI无限画布_Launcher/dist/exe  -> base = AI无限画布/

    策略：从起始目录开始向上查找包含 ai-canvas/ 的目录。
    """
    if getattr(sys, "frozen", False):
        start = os.path.dirname(sys.executable)
    else:
        start = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    d = start
    for _ in range(8):
        if _looks_like_ai_canvas_root(d):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent

    # fallback
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(sys.executable)
        if os.path.basename(exe_dir).lower() == "dist":
            return os.path.dirname(exe_dir)
        return os.path.dirname(exe_dir)
    return start


# id -> sub-directory relative to AI无限画布 root
_SUB_DIRS = {
    "ai_canvas_server": "ai-canvas-server",
    "ai_canvas_app": "ai-canvas",
}


DEFAULT_CONFIG = {
    "version": "1.0.0",
    "window": {
        "width": 1060,
        "height": 720,
        "x": None,
        "y": None,
    },
    "presets": {
        "完整开发环境": ["ai_canvas_server", "ai_canvas_app"],
        "仅后端": ["ai_canvas_server"],
        "仅客户端": ["ai_canvas_app"],
    },
    "projects": [],
}


def _default_projects(base_dir: str) -> list[dict]:
    return [
        {
            "id": "ai_canvas_server",
            "name": "AI Canvas Server",
            "type": "backend",
            "icon": "spring-boot",
            "directory": os.path.join(base_dir, "ai-canvas-server"),
            "commands": ["mvn spring-boot:run -Dspring-boot.run.profiles=dev"],
            "build_commands": ["mvnw.cmd clean package -DskipTests"],
            "build_artifact": os.path.join(
                "target", "ai-canvas-server-1.0.0-SNAPSHOT.jar"
            ),
            "deploy_target": "",
            "port": 8080,
            "env": {"SPRING_PROFILES_ACTIVE": "dev"},
            "delay": 0,
            "depends_on": [],
        },
        {
            "id": "ai_canvas_app",
            "name": "AI Canvas 桌面端",
            "type": "desktop",
            "icon": "tauri",
            "directory": os.path.join(base_dir, "ai-canvas"),
            "commands": ["npm run tauri dev"],
            "build_commands": ["npm run tauri build"],
            "port": 1420,
            "env": {},
            "delay": 2,
            "depends_on": ["ai_canvas_server"],
        },
    ]


def _repair_project_directories(data: dict) -> bool:
    """If saved directories don't exist (stale absolute paths), fix them."""
    base = _project_base_dir()
    changed = False
    for p in data.get("projects", []):
        pid = p.get("id")
        sub = _SUB_DIRS.get(pid)
        if not sub:
            continue
        cur = p.get("directory")
        candidate = os.path.normpath(os.path.join(base, sub))
        if cur and os.path.isdir(cur):
            continue
        if os.path.isdir(candidate) and candidate != os.path.normpath(cur or ""):
            p["directory"] = candidate
            changed = True
    return changed


class ConfigManager:
    def __init__(self, config_path: Optional[str] = None):
        if config_path is None:
            config_path = os.path.join(_exe_dir(), "config.json")
        self.config_path = config_path
        self.data: dict = {}
        self._load()

    def _load(self):
        if os.path.exists(self.config_path):
            with open(self.config_path, "r", encoding="utf-8") as f:
                self.data = json.load(f)
            if _repair_project_directories(self.data):
                self.save()
        else:
            self.data = dict(DEFAULT_CONFIG)
            self.data["projects"] = _default_projects(_project_base_dir())
            self.save()

    def save(self):
        os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
        with open(self.config_path, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=2)

    @property
    def projects(self) -> list[dict]:
        return self.data.get("projects", [])

    @projects.setter
    def projects(self, value: list[dict]):
        self.data["projects"] = value
        self.save()

    @property
    def presets(self) -> dict[str, list[str]]:
        return self.data.get("presets", {})

    @presets.setter
    def presets(self, value: dict[str, list[str]]):
        self.data["presets"] = value
        self.save()

    @property
    def window_config(self) -> dict:
        return self.data.get("window", DEFAULT_CONFIG["window"])

    @window_config.setter
    def window_config(self, value: dict):
        self.data["window"] = value
        self.save()

    def get_project(self, project_id: str) -> Optional[dict]:
        for p in self.projects:
            if p["id"] == project_id:
                return p
        return None

    def update_project(self, project_id: str, updates: dict):
        for i, p in enumerate(self.data["projects"]):
            if p["id"] == project_id:
                self.data["projects"][i].update(updates)
                self.save()
                return

    def add_project(self, project: dict):
        self.data["projects"].append(project)
        self.save()

    def remove_project(self, project_id: str):
        self.data["projects"] = [
            p for p in self.data["projects"] if p["id"] != project_id
        ]
        self.save()

    def topo_sort(self, project_ids: list[str]) -> list[str]:
        id_set = set(project_ids)
        graph: dict[str, list[str]] = {pid: [] for pid in project_ids}
        in_degree: dict[str, int] = {pid: 0 for pid in project_ids}

        for pid in project_ids:
            proj = self.get_project(pid)
            if proj:
                for dep in proj.get("depends_on", []):
                    if dep in id_set:
                        graph[dep].append(pid)
                        in_degree[pid] += 1

        queue = [pid for pid in project_ids if in_degree[pid] == 0]
        result: list[str] = []
        while queue:
            node = queue.pop(0)
            result.append(node)
            for neighbor in graph[node]:
                in_degree[neighbor] -= 1
                if in_degree[neighbor] == 0:
                    queue.append(neighbor)

        return result
