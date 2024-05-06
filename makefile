build:
	docker build . -t localhost:32000/walter

publish: build
	docker push localhost:32000/walter

deploy: publish
	microk8s kubectl delete --ignore-not-found=true -f ./manifest.yaml
	microk8s kubectl apply -f ./manifest.yaml