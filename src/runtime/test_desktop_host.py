import json
import subprocess
import sys
import unittest
from pathlib import Path


class DesktopHostTests(unittest.TestCase):
    def test_shared_core_without_gui_or_agent_cli_import(self):
        code = (
            "import desktop_host,sys,json;"
            "print(json.dumps({k:k in sys.modules for k in "
            "['app','tkinter','jsonl_cli','runtime_core','runtime_protocol']}))"
        )
        result = subprocess.run([sys.executable, '-c', code], capture_output=True,
                                text=True, check=True, timeout=20,
                                cwd=Path(__file__).parent)
        self.assertEqual(json.loads(result.stdout), {
            'app': False, 'tkinter': False, 'jsonl_cli': False,
            'runtime_core': True, 'runtime_protocol': True,
        })

    def test_private_entry_rejects_agent_flag(self):
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name('desktop_host.py')), '--jsonl'],
            capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 2)

    def test_private_protocol_multiple_requests_and_cleanup_without_connect(self):
        requests = [{'id': n, 'operation': 'capabilities'} for n in (1, 2)]
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name('desktop_host.py')), '--desktop-ipc'],
            input=''.join(json.dumps(row)+'\n' for row in requests),
            capture_output=True, text=True, encoding='utf-8', timeout=20, check=True)
        rows = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([row['id'] for row in rows[:-1]], [1, 2])
        self.assertTrue(all(row['ok'] for row in rows[:-1]))
        self.assertEqual(rows[-1], {'event': 'closed', 'cleanup': {'disconnected': True}})


if __name__ == '__main__':
    unittest.main()
