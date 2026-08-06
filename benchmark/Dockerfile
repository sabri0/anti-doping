# Caliper with the Fabric 2.2 SDK binding baked in.
#
# The stock image performs `caliper bind` on every run, which costs ~90 seconds
# and needs network access. Baking it in makes benchmark runs repeatable and
# offline. Running as root is required because the bind-mounted crypto material
# is not readable by the image's unprivileged `node` user; NPM_CONFIG_PREFIX is
# pinned so the binding lands where the CLI looks for it regardless of user.
FROM hyperledger/caliper:0.6.0
USER root
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH=/home/node/.npm-global/bin:$PATH
RUN caliper bind --caliper-bind-sut fabric:2.2
WORKDIR /work
ENTRYPOINT ["caliper"]
