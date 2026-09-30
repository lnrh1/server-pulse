# Server Pulse — 为 Linux 服务器打造的资源监控

> 清晰、轻量、安全的资源监控

## 特点

- **Token 鉴权**，只有拿到口令才能看到服务器负载
- **零依赖单文件**，常驻约 20–40 MB 内存
- **程序只读**，不执行任何命令，无系统控制权限
- **运行期不落盘**，不写日志文件，不写会话文件
- **Cookie 验证**，默认五天内无需再次登录

## 环境

- Linux 系统，依赖 `/proc` 与 `/sys`
- Node.js 18 或更高版本

```bash
node -v
```

## 使用

### 运行

```bash
git clone https://github.com/lnrh1/server-pulse.git
cd server-pulse && bash start.sh
```

第一次运行会生成 `config.json`，并在终端打印登录口令。浏览器打开 `http://<服务器IP>:8080/`，在登录页输入口令即可。

想换成自己的口令，编辑 `config.json` 里的 `token`，然后重启进程。

端口 8080 被占用时，首次运行可以指定端口：

```bash
MONITOR_PORT=<端口号> bash start.sh
```

### 设置为系统服务

```bash
bash install.sh
```

脚本会自动提权，把程序装到 `/opt/serverpulse`，注册成 `serverpulse` 服务并设为开机自启，结束时打印面板地址与登录口令。

服务会重启一次，运行期改动才会生效。查看输出：

```bash
journalctl -u serverpulse -n 20
```

### 修改端口

前台运行时，首次启动指定 `MONITOR_PORT`，或者编辑 `config.json` 里的 `port` 后重新运行。

已装成系统服务后，编辑 `config.json` 里的 `port`，然后重启：

```bash
systemctl restart serverpulse
```

全新安装时也可以直接指定：

```bash
PORT=<端口号> bash install.sh
```

### 卸载

```bash
sudo bash uninstall.sh --purge 
```

## 采集内容

| 项目  | 包括                                                      |
| --- | ------------------------------------------------------- |
| CPU | 总使用率、每核占用、1/5/15 分钟负载、进程数、用户/系统/IO 等待/steal、采样区间 Top 进程 |
| 内存  | 已用、可用、缓冲缓存、buffers、共享、swap                              |
| 磁盘  | 各分区容量、inode 使用率、读/写速率                                   |
| 网络  | 逐网卡实时速率与累计上下行、内外网 IP、公网 IP                              |
| 系统  | 主机名、发行版、内核、架构、CPU 型号与核数、运行时长                            |

每 2 秒采样一次，数据不落盘。

## 接口

| 地址                           | 说明        |
| ---------------------------- | --------- |
| `GET /`                      | 监控面板      |
| `GET /api/stats`             | 当前快照 JSON |
| `GET /login` · `POST /login` | 登录页、提交口令  |
| `GET /logout`                | 清除本设备会话   |
| `GET /favicon.ico`           | 图标，免登录    |

脚本或监控取数不用登录，带上口令即可：

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:8080/api/stats
```

## 配置

编辑 `config.json`：

| 键               | 默认                                            | 说明                            | 环境变量                     |
| --------------- | --------------------------------------------- | ----------------------------- | ------------------------ |
| `token`         | 空                                             | 登录口令，空即不鉴权；启动时打印到终端           | `MONITOR_TOKEN`          |
| `sessionDays`   | 5                                             | 登录后免登录天数                      | `MONITOR_SESSION_DAYS`   |
| `sessionFile`   | `false`                                       | 会话是否落盘；`false` 只放内存，重启需重新登录   | `MONITOR_SESSION_FILE=1` |
| `port`          | 8080                                          | 监听端口                          | `MONITOR_PORT`           |
| `host`          | 0.0.0.0                                       | 监听地址                          | `MONITOR_HOST`           |
| `intervalMs`    | 2000                                          | 采样间隔                          | `MONITOR_INTERVAL`       |
| `label`         | 主机名                                           | 页面标题上的别名                      | `MONITOR_LABEL`          |
| `netExclude`    | lo / docker0 / br- / veth / virbr / tun / tap | 不计入汇总的网卡前缀                    | —                        |
| `mountsExclude` | /snap/ /run/ /dev/ /proc/ /sys/ /boot/efi     | 不展示的挂载点前缀                     | —                        |
| `corsOrigin`    | `*`                                           | `Access-Control-Allow-Origin` | —                        |

## 文件

```
server-pulse/
├── monitor.mjs           采集与 HTTP 服务，单文件零依赖，约 620 行
├── dashboard.html        监控面板
├── login.html            登录页
├── favicon.ico           图标
├── start.sh              前台启动
├── install.sh            安装为 systemd 服务
├── uninstall.sh          卸载
└── config.example.json   配置示例
```

## 许可证

本项目基于 MIT License 开源。

Copyright © 2026 lnrh1
