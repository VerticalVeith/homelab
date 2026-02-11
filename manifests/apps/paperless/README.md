# Paperless

To bootstrap paperless, shell into the pod and run `python3 manage.py createsuperuser`.

https://github.com/paperless-ngx/paperless-ngx/wiki/Email-OAuth-App-Setup#gmail

Callback: https://dms.buergerhoff.com/api/oauth/callback/

Create client secret:

```bash
$key=''
kubectl create secret generic -n paperless gmail --from-literal=oauth-secret=$key
```
