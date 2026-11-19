#!/usr/bin/env python3
"""Regresión DIS-01 sin Azure: python3 verificacion/dis01/probar-topologia.py (Bash + jq)."""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SERVICIOS = ("api-gateway", "auction-service", "realtime-gateway")

MOCK = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ["DIS01_MOCK"])
args = sys.argv[1:]
def arg(*names):
    return next((args[args.index(n)+1] for n in names if n in args), None)
def config(app): return root / (app + ".json")
if pathlib.Path(sys.argv[0]).name == "az":
    if args[:2] == ["extension", "add"] or args[:3] == ["postgres", "flexible-server", "start"]:
        sys.exit(0)
    app = arg("--name", "-n")
    if args[:2] == ["containerapp", "show"]:
        data = json.loads(config(app).read_text())
        if arg("--query") == "properties.configuration.ingress.fqdn": print(data["properties"]["configuration"]["ingress"]["fqdn"])
        else: print(json.dumps(data))
    elif args[:2] == ["containerapp", "update"]:
        data = json.loads(pathlib.Path(arg("--yaml")).read_text()) if arg("--yaml") else json.loads(config(app).read_text())
        for flag, key in [("--min-replicas", "minReplicas"), ("--max-replicas", "maxReplicas")]:
            if arg(flag): data["properties"]["template"]["scale"][key] = int(arg(flag))
        resources = data["properties"]["template"]["containers"][0]["resources"]
        if arg("--cpu"): resources["cpu"] = float(arg("--cpu"))
        if arg("--memory"): resources["memory"] = arg("--memory")
        if arg("--set-env-vars"):
            key, value = arg("--set-env-vars").split("=", 1)
            container = data["properties"]["template"]["containers"][0]
            container["env"] = [x for x in container["env"] if x["name"] != key] + [{"name": key, "value": value}]
        config(app).write_text(json.dumps(data))
    elif args[:3] == ["containerapp", "revision", "list"]:
        print(app + "--latest")
    elif args[:3] == ["containerapp", "replica", "list"]:
        minimum = json.loads(config(app).read_text())["properties"]["template"]["scale"]["minReplicas"]
        count = int(os.environ.get("DIS01_AUCTION_COUNT", minimum)) if app.startswith("auction-service") else minimum
        ready = int(os.environ.get("DIS01_AUCTION_READY", count)) if app.startswith("auction-service") else count
        print(json.dumps([{"name": app+"-"+str(i), "properties": {"containers": [{"ready": i < ready}]}} for i in range(count)]))
    else: raise SystemExit("Comando az no simulado")
else:
    if args[-1].endswith("/actuator/health/readiness"): print('{"status":"UP"}')
    elif args[-1].endswith("/actuator/prometheus"):
        counter = root / "counter"
        n = int(counter.read_text()) if counter.exists() else 0
        counter.write_text(str(n+1))
        count = int(os.environ.get("DIS01_TRAFFIC_INSTANCES", os.environ.get("DIS01_AUCTION_COUNT", "2")))
        print('metric{instancia="r'+str(n % count)+'"} 1')
    else: raise SystemExit("URL curl no simulada")
'''


class Topologia(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.bin = self.path / "bin"
        self.bin.mkdir()
        for cmd in ("az", "curl"):
            target = self.bin / cmd
            target.write_text(MOCK)
            target.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.bin)+os.pathsep+os.environ["PATH"],
                        DIS01_MOCK=str(self.path), INTERNAL_TOKEN="test-only-token")
        self.original = {}
        for suffix in ("", "-prod"):
            for service in (*SERVICIOS, "identity-service", "wallet-service", "streaming-service"):
                app = service + suffix
                data = {"name": app, "properties": {
                    "configuration": {"ingress": {"fqdn": app+".example.test"}, "activeRevisionsMode": "Single"},
                    "template": {"scale": {"minReplicas": 2, "maxReplicas": 4, "cooldownPeriod": 300},
                                 "containers": [{"name": service, "image": "keep-this-image",
                                                 "env": [{"name": "TEST_VALUE", "value": "test-only-secret"}],
                                                 "resources": {"cpu": 0.25, "memory": "0.5Gi", "ephemeralStorage": "1Gi"}}]}}}
                self.original[app] = copy.deepcopy(data)
                if service == "auction-service":
                    data["properties"]["template"]["containers"][0]["env"].append({"name": "DB_POOL_MAX", "value": "10"})
                    self.original[app] = copy.deepcopy(data)
                self.write(app, data)

    def write(self, app, data):
        (self.path / (app+".json")).write_text(json.dumps(data))

    def read(self, app):
        return json.loads((self.path / (app+".json")).read_text())

    def run_script(self, name, *args, success=True, **env):
        result = subprocess.run(["bash", str(ROOT / "scripts" / name), *args],
                                env=dict(self.env, **env), capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stdout+result.stderr)
        self.assertNotIn("test-only-secret", result.stdout+result.stderr)
        return result

    def test_configurar_qa_prod_preserva_campos(self):
        for environment, suffix in (("qa", ""), ("prod", "-prod")):
            self.run_script("dis-01-configurar.sh", environment)
            self.run_script("dis-01-configurar.sh", environment)  # Reaplicar no duplica DB_POOL_MAX.
            for service in SERVICIOS:
                app = service+suffix
                data, before = self.read(app), self.original[app]
                template = data["properties"]["template"]
                scale = template["scale"]
                expected = (2, 4)
                self.assertEqual((scale["minReplicas"], scale["maxReplicas"]), expected)
                self.assertEqual(scale["cooldownPeriod"], 300)
                self.assertEqual(scale["rules"][0]["http"]["metadata"]["concurrentRequests"], "20")
                container = template["containers"][0]
                old = before["properties"]["template"]["containers"][0]
                for field in ("image", "name"):
                    self.assertEqual(container[field], old[field])
                expected_env = old["env"] if service != "auction-service" else [x for x in old["env"] if x["name"] != "DB_POOL_MAX"] + [{"name": "DB_POOL_MAX", "value": "2"}]
                self.assertEqual(container["env"], expected_env)
                self.assertEqual(data["properties"]["configuration"], before["properties"]["configuration"])
                self.assertEqual(container["resources"]["ephemeralStorage"], "1Gi")
                resources = container["resources"]
                self.assertEqual((resources["cpu"], resources["memory"]), (0.25, "0.5Gi") if service == "api-gateway" else (0.5, "1Gi"))
                self.assertEqual({p["type"] for p in container["probes"]}, {"Startup", "Readiness", "Liveness"})
            self.run_script("dis-01-verificar.sh", environment)

    def test_verificar_acepta_dos_a_cuatro_y_rechaza_instancias_no_listas_o_sin_reparto(self):
        self.run_script("dis-01-configurar.sh", "qa")
        self.run_script("dis-01-verificar.sh", "qa")
        self.run_script("dis-01-verificar.sh", "qa", DIS01_AUCTION_COUNT="4")
        self.run_script("dis-01-verificar.sh", "qa", success=False, DIS01_AUCTION_COUNT="5")
        self.run_script("dis-01-verificar.sh", "qa", success=False, DIS01_AUCTION_READY="1")
        self.run_script("dis-01-verificar.sh", "qa", success=False, DIS01_TRAFFIC_INSTANCES="1")

    def test_verificar_rechaza_limites_y_recursos_anteriores(self):
        self.run_script("dis-01-configurar.sh", "qa")
        data = self.read("auction-service")
        data["properties"]["template"]["scale"].update(minReplicas=4, maxReplicas=6)
        self.write("auction-service", data)
        result = self.run_script("dis-01-verificar.sh", "qa", success=False)
        self.assertIn("DIS-01 no cumple en 1 servicio(s).", result.stderr)
        data["properties"]["template"]["scale"].update(minReplicas=2, maxReplicas=4)
        data["properties"]["template"]["containers"][0]["resources"]["cpu"] = 0.25
        self.write("auction-service", data)
        self.run_script("dis-01-verificar.sh", "qa", success=False)

    def test_verificar_rechaza_pool_que_agota_presupuesto(self):
        self.run_script("dis-01-configurar.sh", "qa")
        data = self.read("auction-service")
        data["properties"]["template"]["containers"][0]["env"] = [{"name": "DB_POOL_MAX", "value": "10"}]
        self.write("auction-service", data)
        self.run_script("dis-01-verificar.sh", "qa", success=False)

    def test_encender_conserva_topologia_y_servicios_base(self):
        self.run_script("azure-encender.sh")
        for service in (*SERVICIOS, "identity-service", "wallet-service", "streaming-service"):
            template = self.read(service)["properties"]["template"]
            expected = (2, 4) if service in SERVICIOS else (1, 2)
            self.assertEqual((template["scale"]["minReplicas"], template["scale"]["maxReplicas"]), expected)
            if service in ("auction-service", "realtime-gateway"):
                self.assertEqual(template["containers"][0]["resources"]["cpu"], 0.5)
                self.assertEqual(template["containers"][0]["resources"]["memory"], "1Gi")
                if service == "auction-service":
                    self.assertEqual([x for x in template["containers"][0]["env"] if x["name"] == "DB_POOL_MAX"], [{"name": "DB_POOL_MAX", "value": "2"}])
            else:
                self.assertEqual(template["containers"][0]["resources"], self.original[service]["properties"]["template"]["containers"][0]["resources"])

    @unittest.skipUnless(shutil.which("node"), "Node no disponible")
    def test_minimo_del_generador_acepta_historia_y_rechaza_valores_invalidos(self):
        env = dict(self.env)
        env.pop("REN01_SUBASTA", None)
        script = ROOT / "verificacion" / "dis01" / "caos-bajo-carga.mjs"
        for value in ("1", "2.5", "no-numero"):
            result = subprocess.run(["node", str(script), "--replicas-minimas", value],
                                    env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("--replicas-minimas debe ser", result.stderr)
        for args in ([], ["--replicas-minimas", "2"], ["--replicas-minimas", "4"]):
            result = subprocess.run(["node", str(script), *args], env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Falta REN01_SUBASTA", result.stderr)


if __name__ == "__main__":
    if not shutil.which("bash") or not shutil.which("jq"):
        raise SystemExit("Requiere Bash y jq; ejecutar en Linux o Cloud Shell. No usa Azure real.")
    unittest.main()
