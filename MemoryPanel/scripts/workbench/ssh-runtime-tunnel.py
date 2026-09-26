#!/usr/bin/env python3
"""Reconnect one private runtime bridge using Python 3 stdlib and OpenSSH.

    python3 ssh-runtime-tunnel.py --config /private/path/orca-tunnel.json

Config JSON (all five fields are required; credentials stay outside the repo):
    {"key": "/private/id_ed25519", "knownHosts": "/private/known_hosts",
     "host": "user@example.com", "socketPath": "/private/runtime.sock",
     "localPort": 8791}

The remote Linux host needs python3 and /proc/net/unix. The destination is always
127.0.0.1. Each attempt checks only socketPath; an active/bound socket, symlink,
regular file, ambiguous probe, or inode change is preserved. Only a refused,
unbound, unchanged Unix socket is removed. Do not enable StreamLocalBindUnlink
on the SSH server: it would bypass these checks when sshd creates the forward.

One launcher per host/socket is allowed by a local flock. SIGINT/SIGTERM stops
its SSH child and exits; disconnects retry after five seconds. This does not
start the local runtime. SSH output is suppressed to keep credentials/paths
out of logs; failures have generic status messages.
"""

import argparse
import dataclasses
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time


RETRY_SECONDS = 5
PREPARE_TIMEOUT_SECONDS = 30
REQUIRED_FIELDS = {"key", "knownHosts", "host", "socketPath", "localPort"}

# Sent as a quoted argument to python3, not interpolated into remote shell code.
# /proc/net/unix includes bound sockets that do not yet accept connections.
REMOTE_CLEANUP_SCRIPT = r'''
import errno
import json
import os
import socket
import stat
import sys


def kernel_has_path(path):
    with open('/proc/net/unix', encoding='utf-8') as entries:
        if next(entries).split() != ['Num', 'RefCount', 'Protocol', 'Flags', 'Type', 'St', 'Inode', 'Path']:
            raise ValueError('unexpected socket table')
        for entry in entries:
            fields = entry.rstrip('\n').split(None, 7)
            if len(fields) < 7 or not fields[0].endswith(':'):
                raise ValueError('unexpected socket entry')
            if len(fields) == 8 and fields[7] == path:
                return True
    return False


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_ctime_ns)


def clean_socket(path):
    try:
        original = os.lstat(path)
    except FileNotFoundError:
        return 'ready'
    if not stat.S_ISSOCK(original.st_mode):
        return 'unsafe'
    if kernel_has_path(path):
        return 'active'
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        probe.settimeout(2)
        try:
            probe.connect(path)
        except OSError as error:
            if error.errno != errno.ECONNREFUSED:
                return 'unsafe'
        else:
            return 'active'
    # A second kernel-table check catches a newly bound/listening endpoint.
    if kernel_has_path(path):
        return 'active'
    try:
        current = os.lstat(path)
    except FileNotFoundError:
        return 'ready'
    if identity(original) != identity(current) or not stat.S_ISSOCK(current.st_mode):
        return 'unsafe'
    os.unlink(path)
    return 'ready'


def main():
    try:
        status = clean_socket(sys.argv[1])
    except (OSError, ValueError, IndexError, StopIteration):
        status = 'unsafe'
    print(json.dumps({'status': status}))
    return {'ready': 0, 'active': 75, 'unsafe': 78}[status]


if __name__ == '__main__':
    sys.exit(main())
'''


class ConfigurationError(ValueError):
    pass


class AlreadyRunningError(RuntimeError):
    pass


@dataclasses.dataclass(frozen=True)
class TunnelConfig:
    key: Path
    known_hosts: Path
    host: str
    socket_path: str
    local_port: int


def private_file(value, field):
    if not isinstance(value, str) or any(char in value for char in '\r\n\0'):
        raise ConfigurationError(f'{field} must be an absolute regular-file path')
    path = Path(value)
    if not path.is_absolute() or not path.is_file():
        raise ConfigurationError(f'{field} must be an absolute regular-file path')
    return path.resolve()


def load_config(path):
    try:
        with open(path, encoding='utf-8') as source:
            document = source.read(65537)
        if len(document) > 65536:
            raise ConfigurationError('config exceeds 64 KiB')
        data = json.loads(document)
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ConfigurationError('config must be a readable JSON file') from None
    if not isinstance(data, dict) or set(data) != REQUIRED_FIELDS:
        raise ConfigurationError('config must contain exactly key, knownHosts, host, socketPath, localPort')
    host = data['host']
    if not isinstance(host, str) or not re.fullmatch(
        r'(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*', host
    ):
        raise ConfigurationError('host must be a hostname or IPv4 address, optionally prefixed with user@')
    socket_path = data['socketPath']
    if (
        not isinstance(socket_path, str)
        or not re.fullmatch(r'/[A-Za-z0-9_./-]+', socket_path)
        or '..' in PurePosixPath(socket_path).parts
        or str(PurePosixPath(socket_path)) != socket_path
        or socket_path.startswith('//')
        or len(socket_path.encode('utf-8')) > 107
    ):
        raise ConfigurationError('socketPath must be a normalized absolute Unix socket path, at most 107 bytes')
    port = data['localPort']
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise ConfigurationError('localPort must be an integer from 1 through 65535')
    return TunnelConfig(
        private_file(data['key'], 'key'), private_file(data['knownHosts'], 'knownHosts'),
        host, socket_path, port,
    )


def ssh_arguments(config):
    # OpenSSH parses -o values as config syntax, including paths with spaces.
    known_hosts = str(config.known_hosts).replace('\\', '\\\\').replace('"', '\\"')
    options = [
        'IdentityAgent=none', 'IdentitiesOnly=yes', 'BatchMode=yes',
        'StrictHostKeyChecking=yes', f'UserKnownHostsFile="{known_hosts}"',
        'GlobalKnownHostsFile=/dev/null', 'KnownHostsCommand=none',
        'UpdateHostKeys=no', 'VerifyHostKeyDNS=no',
        'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no',
        'PreferredAuthentications=publickey', 'ControlMaster=no', 'ControlPath=none',
        'ConnectTimeout=10', 'ConnectionAttempts=1',
        'ServerAliveInterval=20', 'ServerAliveCountMax=3',
        'ExitOnForwardFailure=yes', 'LogLevel=ERROR',
    ]
    args = ['ssh', '-F', '/dev/null', '-T', '-i', str(config.key)]
    for option in options:
        args.extend(['-o', option])
    return args


def prepare_arguments(config):
    command = shlex.join(['python3', '-c', REMOTE_CLEANUP_SCRIPT, config.socket_path])
    return ssh_arguments(config) + [config.host, command]


def forward_arguments(config):
    forward = f'{config.socket_path}:127.0.0.1:{config.local_port}'
    return ssh_arguments(config) + ['-N', '-R', forward, config.host]


class LauncherLock:
    def __init__(self, config, directory=None):
        self.directory = Path(directory) if directory else (
            Path(tempfile.gettempdir()) / f'tencent-workbench-tunnels-{os.getuid()}'
        )
        # Deliberately exclude localPort/key/config path: duplicate destinations
        # must not race just because their local config files differ.
        self.name = hashlib.sha256(
            f'{config.host.rsplit("@", 1)[-1].lower()}\0{config.socket_path}'.encode()
        ).hexdigest() + '.lock'
        self.fd = None

    def __enter__(self):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory_stat = self.directory.lstat()
        if (
            not stat.S_ISDIR(directory_stat.st_mode)
            or directory_stat.st_uid != os.getuid()
            or directory_stat.st_mode & 0o077
        ):
            raise ConfigurationError('lock directory must be a private directory owned by the current user')
        fd = os.open(self.directory / self.name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
                raise ConfigurationError('lock file must be private and owned by the current user')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise AlreadyRunningError('a launcher already owns this host/socket') from None
            os.ftruncate(fd, 0)
            os.write(fd, str(os.getpid()).encode())
            self.fd = fd
        except BaseException:
            os.close(fd)
            raise
        return self

    def __exit__(self, *_):
        # Keep the lock inode: unlinking it allows two processes to lock distinct
        # inodes under the same path while an older process still holds a lock.
        os.close(self.fd)
        self.fd = None


def stop_child(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def run_child(args, stop, timeout=None, capture=False):
    if stop.is_set():
        return None, ''
    child = subprocess.Popen(
        args, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, text=True, start_new_session=True,
    )
    deadline = time.monotonic() + timeout if timeout is not None else None
    try:
        while not stop.is_set():
            if deadline is not None and time.monotonic() >= deadline:
                return None, ''
            try:
                output, _ = child.communicate(timeout=0.25)
                return child.returncode, output or ''
            except subprocess.TimeoutExpired:
                continue
        return None, ''
    finally:
        stop_child(child)


def log(message):
    print(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), message, flush=True)


def reconnect(config, stop):
    while not stop.is_set():
        code, output = run_child(prepare_arguments(config), stop, PREPARE_TIMEOUT_SECONDS, capture=True)
        if stop.is_set():
            break
        try:
            status = json.loads(output)['status']
        except (ValueError, KeyError, TypeError):
            status = 'failed'
        if code == 0 and status == 'ready':
            log('Socket ready; starting private SSH forward.')
            code, _ = run_child(forward_arguments(config), stop)
            if not stop.is_set():
                log('SSH forward ended; retrying in 5 seconds.')
        elif code == 75 and status == 'active':
            log('Remote socket is active; preserving it and retrying in 5 seconds.')
        elif code == 78 and status == 'unsafe':
            log('Remote socket cannot be safely cleared; preserving it and retrying in 5 seconds.')
        else:
            log('Remote preparation failed; retrying in 5 seconds.')
        stop.wait(RETRY_SECONDS)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--config', required=True, type=Path, help='private JSON configuration file')
    parser.add_argument('--lock-dir', type=Path, help='private directory for local launcher locks')
    args = parser.parse_args(argv)
    stop = threading.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stop.set())
    try:
        config = load_config(args.config)
        with LauncherLock(config, args.lock_dir):
            reconnect(config, stop)
    except (ConfigurationError, AlreadyRunningError) as error:
        log(str(error))
        return 2
    except OSError:
        log('Launcher failed to access a required local resource or start SSH.')
        return 1
    log('Tunnel launcher stopped.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
