# 部署面板

当前个人 fork 只保留本地二进制包 + systemd 部署方式。

## 本地 systemd 一键部署

以 root 用户执行：

```bash
curl -fsSL https://raw.githubusercontent.com/Su-cyber-art/Forwardx/main/scripts/install-panel-local.sh | FORWARDX_GITHUB_REPO=Su-cyber-art/Forwardx bash -s -- install
```

安装完成后访问：

```text
http://服务器IP:9810
```

第一次打开面板时不会直接进入后台，而是进入初始化向导。你需要先选择数据库，再创建管理员账号。

常用命令：

```bash
# 升级面板
curl -fsSL https://raw.githubusercontent.com/Su-cyber-art/Forwardx/main/scripts/install-panel-local.sh | FORWARDX_GITHUB_REPO=Su-cyber-art/Forwardx bash -s -- upgrade

# 指定版本升级
curl -fsSL https://raw.githubusercontent.com/Su-cyber-art/Forwardx/main/scripts/install-panel-local.sh | FORWARDX_GITHUB_REPO=Su-cyber-art/Forwardx FORWARDX_TARGET_VERSION=vX.Y.Z bash -s -- upgrade

# 卸载面板
curl -fsSL https://raw.githubusercontent.com/Su-cyber-art/Forwardx/main/scripts/install-panel-local.sh | FORWARDX_GITHUB_REPO=Su-cyber-art/Forwardx bash -s -- uninstall

# 查看面板日志
journalctl -u forwardx-panel -n 300 --no-pager
```

默认安装目录通常是：

```text
/opt/forwardx-panel
```

如需卸载本地面板，请先阅读 [卸载 ForwardX](./uninstall.md)，确认是否保留安装目录和数据库。

## 本地 systemd 手动部署

本地手动部署适合不想执行一键脚本的用户。建议直接使用当前 fork GitHub Release 中的面板安装包，不建议普通用户在服务器上从源码编译。

### 1. 准备 Node.js 和 pnpm

ForwardX 面板需要 Node.js 22 或以上版本。

Ubuntu/Debian 示例：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs curl tar gzip
corepack enable
corepack prepare pnpm@10.28.1 --activate
node -v
pnpm -v
```

如果你使用 CentOS、AlmaLinux、Rocky Linux、Debian 旧版本或其他系统，只要最终 `node -v` 是 22 或以上，`pnpm -v` 能正常输出即可。

### 2. 下载面板安装包

把 `VERSION` 改成当前 fork GitHub Releases 中的最新版本号：

```bash
VERSION=v2.3.200
APP_DIR=/opt/forwardx-panel

mkdir -p "$APP_DIR"
curl -fL "https://github.com/Su-cyber-art/Forwardx/releases/download/${VERSION}/forwardx-panel-${VERSION}.tar.gz" -o /tmp/forwardx-panel.tar.gz
tar -xzf /tmp/forwardx-panel.tar.gz -C "$APP_DIR"
cd "$APP_DIR"
pnpm install --prod --frozen-lockfile
```

如果下载时提示安装包不存在，通常是 GitHub Actions 还没有把该版本安装包上传完成，稍后重试即可。如果安装包内包含依赖补丁目录，保持 `patches` 目录和 `package.json` 在同一安装目录下。

### 3. 写入运行环境

先生成随机登录密钥：

```bash
openssl rand -hex 32
```

创建数据目录和 `.env`：

```bash
mkdir -p /opt/forwardx-panel/data
cat > /opt/forwardx-panel/.env <<'EOF'
NODE_ENV=production
PORT=9810
DATABASE_CONFIG_PATH=/opt/forwardx-panel/data/database.json
SQLITE_PATH=/opt/forwardx-panel/data/forwardx.db
MYSQL_CONFIG_PATH=/opt/forwardx-panel/data/mysql.json
JWT_SECRET=请替换为随机字符串
FORWARDX_PORT_CONFIG_PATH=/opt/forwardx-panel/.env
FORWARDX_PORT_MANAGEMENT=local
FORWARDX_UPGRADE_COMMAND=/bin/bash /opt/forwardx-panel/scripts/install-panel-local.sh upgrade
EOF
chmod 600 /opt/forwardx-panel/.env
```

不确定数据库怎么选时，不需要提前写数据库变量。首次进入面板时选择 SQLite 即可。更多环境变量见 [环境变量](./env-vars.md)。

### 4. 创建 systemd 服务

```bash
cat > /etc/systemd/system/forwardx-panel.service <<'EOF'
[Unit]
Description=ForwardX Panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/forwardx-panel
EnvironmentFile=/opt/forwardx-panel/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now forwardx-panel
journalctl -u forwardx-panel -n 100 --no-pager
```

浏览器访问：

```text
http://服务器IP:9810
```

### 5. 手动升级本地面板

升级前建议先备份 `/opt/forwardx-panel/data`。升级时保留 `data` 和 `.env`，只替换程序文件。

```bash
VERSION=v2.3.200
APP_DIR=/opt/forwardx-panel

systemctl stop forwardx-panel
cd "$APP_DIR"
rm -rf dist client drizzle scripts
rm -f package.json pnpm-lock.yaml pnpm-workspace.yaml
curl -fL "https://github.com/Su-cyber-art/Forwardx/releases/download/${VERSION}/forwardx-panel-${VERSION}.tar.gz" -o /tmp/forwardx-panel.tar.gz
tar -xzf /tmp/forwardx-panel.tar.gz -C "$APP_DIR"
pnpm install --prod --frozen-lockfile
systemctl start forwardx-panel
journalctl -u forwardx-panel -n 100 --no-pager
```

::: warning 不要删除这些文件
本地部署升级时不要删除 `/opt/forwardx-panel/data` 和 `/opt/forwardx-panel/.env`。前者保存数据库和数据库连接配置，后者保存端口、登录密钥等运行环境。
:::

## 配置域名和 HTTPS

建议使用 Nginx、Caddy 或宝塔反向代理到面板端口。

Nginx 示例：

```nginx
server {
    listen 80;
    server_name panel.example.com;

    location / {
        proxy_pass http://127.0.0.1:9810;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

配置 HTTPS 后，面板公开地址建议填写：

```text
https://panel.example.com
```

## 首次进入面板

部署完成后，浏览器打开面板地址会进入首次初始化页面。

初始化流程：

1. 选择数据库：SQLite、MySQL 或 PostgreSQL。
2. 如果选择 MySQL/PostgreSQL，填写地址、端口、数据库名、用户名、密码和 SSL 开关。
3. 点击保存连接，系统会先测试数据库是否能连接。
4. 创建第一个管理员账号。
5. 登录后台后，在系统设置里填写面板公开地址。

数据库选择建议：

| 数据库 | 适合情况 |
| --- | --- |
| SQLite | 第一次使用、单机、小规模规则，最省心 |
| MySQL | 长期使用、多用户、已有 MySQL 环境 |
| PostgreSQL | 已有 PostgreSQL 环境，或希望使用 PostgreSQL 管理数据 |

更完整的初始化说明可以看 [首次初始化](./first-setup.md)。
