build:
	docker build . -t localhost:32000/walter

publish: build
	docker push localhost:32000/walter

deploy: publish
	microk8s kubectl delete --ignore-not-found=true -f ./manifest.yaml
	microk8s kubectl apply -f ./manifest.yaml

deploy-lightsail:
	docker buildx build --platform linux/amd64 . -t walter:lightsail
	aws lightsail push-container-image \
		--region us-east-1 \
		--service-name walter \
		--label walter \
		--image walter:lightsail