see https://github.com/itzg/minecraft-server-charts/tree/master/charts/minecraft

## Create Curseforge API Token

Create Token at <https://console.curseforge.com/#/> and replace $ with $$.

```bash
$key=''
kubectl create secret generic -n minecraft curseforge --from-literal=cf-api-key=$key
```
