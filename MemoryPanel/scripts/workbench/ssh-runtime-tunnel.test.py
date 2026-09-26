"""Run with: python3 scripts/workbench/ssh-runtime-tunnel.test.py (no SSH/network)."""

import errno
import importlib.util
import io
import json
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import MagicMock, patch


SPEC = importlib.util.spec_from_file_location('ssh_runtime_tunnel', Path(__file__).with_name('ssh-runtime-tunnel.py'))
tunnel = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = tunnel
SPEC.loader.exec_module(tunnel)


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for name in ('private key', 'known hosts'):
            (self.root / name).touch()
        self.data = {
            'key': str(self.root / 'private key'),
            'knownHosts': str(self.root / 'known hosts'),
            'host': 'root@example.com', 'socketPath': '/private/workbench/orca.sock', 'localPort': 8791,
        }

    def load(self, **changes):
        path = self.root / 'config.json'
        path.write_text(json.dumps(dict(self.data, **changes)))
        return tunnel.load_config(path)

    def test_config_and_forward_are_fixed_to_loopback(self):
        config = self.load()
        args = tunnel.forward_arguments(config)
        self.assertEqual(args[args.index('-R') + 1], '/private/workbench/orca.sock:127.0.0.1:8791')
        self.assertEqual(args[:4], ['ssh', '-F', '/dev/null', '-T'])
        for option in (
            'StrictHostKeyChecking=yes', 'GlobalKnownHostsFile=/dev/null',
            'KnownHostsCommand=none', 'IdentityAgent=none', 'IdentitiesOnly=yes',
            'BatchMode=yes', 'ExitOnForwardFailure=yes', 'ControlPath=none',
        ):
            self.assertIn(option, args)
        self.assertIn(f'UserKnownHostsFile="{config.known_hosts}"', args)
        self.assertNotIn('StreamLocalBindUnlink=yes', args)

    def test_remote_script_and_path_are_shell_quoted(self):
        import shlex
        config = self.load()
        args = tunnel.prepare_arguments(config)
        self.assertEqual(args[-2], config.host)
        self.assertEqual(shlex.split(args[-1]), ['python3', '-c', tunnel.REMOTE_CLEANUP_SCRIPT, config.socket_path])

    def test_rejects_invalid_or_ambiguous_destinations(self):
        for field, values in {
            'host': ['-oProxyCommand=bad', 'root@host;bad', 'host\nother', '', 5],
            'socketPath': ['relative.sock', '/a/../b.sock', '/a//b.sock', '/a/./b.sock',
                           '/a:127.0.0.1:99', '//a.sock', '/a.sock/', '/a b.sock', '/' + 'a' * 107, None],
            'localPort': [True, 0, 65536, '8791', 1.5],
            'key': ['relative', '/missing/private/key', None],
            'knownHosts': ['/missing/knownhosts', 'bad\npath'],
        }.items():
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaises(tunnel.ConfigurationError):
                    self.load(**{field: value})

    def test_rejects_extra_target_fields(self):
        with self.assertRaises(tunnel.ConfigurationError):
            self.load(localHost='0.0.0.0')

    def test_lock_is_exclusive_across_config_files_users_and_local_ports(self):
        config = self.load()
        directory = self.root / 'locks'
        other = tunnel.dataclasses.replace(config, host='other@EXAMPLE.COM', local_port=8793)
        with tunnel.LauncherLock(config, directory):
            with self.assertRaises(tunnel.AlreadyRunningError):
                with tunnel.LauncherLock(other, directory):
                    self.fail('duplicate destination acquired lock')
        with tunnel.LauncherLock(other, directory):
            pass

    def test_lock_refuses_symlink_or_public_directory(self):
        config = self.load()
        public = self.root / 'public'
        public.mkdir(mode=0o755)
        public.chmod(0o755)
        with self.assertRaises(tunnel.ConfigurationError):
            with tunnel.LauncherLock(config, public):
                pass
        link = self.root / 'link'
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(tunnel.ConfigurationError):
            with tunnel.LauncherLock(config, link):
                pass


class RemoteCleanupTests(unittest.TestCase):
    def setUp(self):
        self.remote = {'__name__': 'remote_cleanup_test'}
        exec(compile(tunnel.REMOTE_CLEANUP_SCRIPT, '<remote-cleanup>', 'exec'), self.remote)
        self.info = types.SimpleNamespace(st_dev=1, st_ino=2, st_mode=stat.S_IFSOCK | 0o600, st_ctime_ns=3)
        self.remote['os'] = types.SimpleNamespace(lstat=MagicMock(return_value=self.info), unlink=MagicMock())
        self.probe = MagicMock()
        self.probe.connect.side_effect = ConnectionRefusedError(errno.ECONNREFUSED, 'refused')
        socket_factory = MagicMock()
        socket_factory.return_value.__enter__.return_value = self.probe
        self.remote['socket'] = types.SimpleNamespace(AF_UNIX=socket.AF_UNIX, SOCK_STREAM=socket.SOCK_STREAM, socket=socket_factory)
        self.kernel_check = MagicMock(return_value=False)
        self.remote['kernel_has_path'] = self.kernel_check

    def clean(self):
        return self.remote['clean_socket']('/private/runtime.sock')

    def assert_preserved(self, expected):
        self.assertEqual(self.clean(), expected)
        self.remote['os'].unlink.assert_not_called()

    def test_missing_socket_is_ready(self):
        self.remote['os'].lstat.side_effect = FileNotFoundError()
        self.assert_preserved('ready')
        self.kernel_check.assert_not_called()

    def test_regular_files_directories_and_symlinks_are_preserved(self):
        for mode in (stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK):
            with self.subTest(mode=mode):
                self.info.st_mode = mode | 0o600
                self.assert_preserved('unsafe')
        self.probe.connect.assert_not_called()

    def test_kernel_bound_socket_is_preserved_without_connect(self):
        self.kernel_check.return_value = True
        self.assert_preserved('active')
        self.probe.connect.assert_not_called()

    def test_accepting_socket_is_preserved(self):
        self.probe.connect.side_effect = None
        self.assert_preserved('active')

    def test_only_connection_refused_allows_cleanup(self):
        for error in (PermissionError(errno.EACCES, 'denied'), TimeoutError(), FileNotFoundError(errno.ENOENT, 'missing')):
            with self.subTest(error=type(error).__name__):
                self.probe.connect.side_effect = error
                self.assert_preserved('unsafe')

    def test_refused_unbound_unchanged_socket_is_removed(self):
        self.assertEqual(self.clean(), 'ready')
        self.remote['os'].unlink.assert_called_once_with('/private/runtime.sock')
        self.assertEqual(self.remote['os'].lstat.call_count, 2)
        self.assertEqual(self.kernel_check.call_count, 2)

    def test_socket_becoming_bound_during_probe_is_preserved(self):
        self.kernel_check.side_effect = [False, True]
        self.assert_preserved('active')

    def test_changed_socket_or_replacement_file_is_preserved(self):
        for change in ({'st_ino': 4}, {'st_dev': 9}, {'st_ctime_ns': 4}, {'st_mode': stat.S_IFREG | 0o600}):
            with self.subTest(change=change):
                changed = types.SimpleNamespace(**dict(vars(self.info), **change))
                self.remote['os'].lstat.side_effect = [self.info, changed]
                self.assert_preserved('unsafe')

    def test_unreadable_proc_table_fails_closed(self):
        self.kernel_check.side_effect = PermissionError()
        self.remote['sys'] = types.SimpleNamespace(argv=['cleanup', '/private/runtime.sock'])
        with patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(self.remote['main'](), 78)
        self.assertEqual(json.loads(output.getvalue()), {'status': 'unsafe'})
        self.remote['os'].unlink.assert_not_called()

    def test_kernel_table_matches_only_exact_path(self):
        namespace = {'__name__': 'remote_table_test'}
        exec(tunnel.REMOTE_CLEANUP_SCRIPT, namespace)
        table = 'Num RefCount Protocol Flags Type St Inode Path\n0000: 2 0 0000 0001 01 9 /private/runtime.sock.other\n0000: 2 0 0000 0001 01 9 /private/runtime.sock\n'
        with patch('builtins.open', return_value=io.StringIO(table)):
            self.assertTrue(namespace['kernel_has_path']('/private/runtime.sock'))
        with patch('builtins.open', return_value=io.StringIO(table)):
            self.assertFalse(namespace['kernel_has_path']('/private/other.sock'))

    def test_malformed_kernel_table_fails_closed(self):
        namespace = {'__name__': 'remote_table_test'}
        exec(tunnel.REMOTE_CLEANUP_SCRIPT, namespace)
        for table in ('', 'unexpected header\n', 'Num RefCount Protocol Flags Type St Inode Path\nmalformed\n'):
            with self.subTest(table=table), patch('builtins.open', return_value=io.StringIO(table)):
                with self.assertRaises((ValueError, StopIteration)):
                    namespace['kernel_has_path']('/private/runtime.sock')


class LifecycleTests(unittest.TestCase):
    def test_stop_does_not_start_a_child(self):
        stop = threading.Event()
        stop.set()
        with patch.object(tunnel.subprocess, 'Popen') as popen:
            self.assertEqual(tunnel.run_child(['ssh'], stop), (None, ''))
        popen.assert_not_called()

    def test_stop_terminates_and_reaps_a_running_child(self):
        stop = threading.Event()
        child = MagicMock()
        child.poll.return_value = None

        def interrupted(**_):
            stop.set()
            raise subprocess.TimeoutExpired('ssh', 0.25)

        child.communicate.side_effect = interrupted
        with patch.object(tunnel.subprocess, 'Popen', return_value=child):
            self.assertEqual(tunnel.run_child(['ssh'], stop), (None, ''))
        child.terminate.assert_called_once()
        child.wait.assert_called_once_with(timeout=5)

    def test_child_ignoring_termination_is_killed(self):
        child = MagicMock()
        child.poll.return_value = None
        child.wait.side_effect = [subprocess.TimeoutExpired('ssh', 5), 0]
        tunnel.stop_child(child)
        child.kill.assert_called_once()
        self.assertEqual(child.wait.call_count, 2)

    def test_active_unsafe_or_failed_cleanup_never_starts_forward(self):
        config = tunnel.TunnelConfig(Path('/key'), Path('/known'), 'host', '/runtime.sock', 8791)
        for result in ((75, '{"status":"active"}'), (78, '{"status":"unsafe"}'), (255, ''), (0, '{}')):
            with self.subTest(result=result):
                stop = MagicMock()
                stop.is_set.side_effect = [False, False, True]
                with patch.object(tunnel, 'run_child', return_value=result) as run, patch.object(tunnel, 'log'):
                    tunnel.reconnect(config, stop)
                self.assertEqual(run.call_count, 1)
                stop.wait.assert_called_once_with(5)

    def test_ready_cleanup_starts_forward_then_retries(self):
        config = tunnel.TunnelConfig(Path('/key'), Path('/known'), 'host', '/runtime.sock', 8791)
        stop = MagicMock()
        stop.is_set.side_effect = [False, False, False, True]
        with patch.object(tunnel, 'run_child', side_effect=[(0, '{"status":"ready"}'), (255, '')]) as run, patch.object(tunnel, 'log'):
            tunnel.reconnect(config, stop)
        self.assertEqual(run.call_count, 2)
        self.assertIn('-R', run.call_args_list[1].args[0])
        stop.wait.assert_called_once_with(5)


if __name__ == '__main__':
    unittest.main()
