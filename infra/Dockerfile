FROM grimoirelab/full:latest

COPY --chown=grimoirelab:grimoirelab override.cfg /override.cfg
COPY --chown=grimoirelab:grimoirelab organizations.json /home/bitergia/conf/organizations.json
COPY --chown=grimoirelab:grimoirelab projects.json /home/bitergia/conf/projects.json

ADD entrypoint-full.sh /entrypoint.sh

RUN sudo chown grimoirelab:grimoirelab /entrypoint.sh
RUN sudo chmod 755 /entrypoint.sh