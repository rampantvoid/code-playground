import Dockerode from "dockerode";
import { PassThrough } from "stream";
import { WebSocket } from "ws";
import { env } from "./env";
import { TemplateType } from "./db/types";
import uniqueSlug from "unique-slug";
import { redis } from "./upstash/ratelimit";

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

export const startPlaygroundBash = async (w: WebSocket) => {
  const container = await docker.getContainer(
    "de4c0b873a6a68b0c7f40f27b6213a13313a09eb4a560767234ecbf2a41e6dc6"
  );

  const inspect = await container.inspect();

  console.log("available exec sessions");
  console.log(inspect.ExecIDs);

  const exec = await container.exec({
    Cmd: ["bash"],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    User: "bun",
    WorkingDir: "/home/bun",
    Env: ["TERM=xterm-256color"],
  });

  await exec.start(
    {
      stdin: true,
      hijack: true,
    },
    function (err, stream) {
      if (err) throw err;
      if (!stream) {
        return console.log("???");
      }

      console.log("**creating exec session**");

      w.onmessage = (e) => {
        stream.write(e.data.toString());
      };

      const fromContainerStdout = new PassThrough();
      const fromContainerStderr = new PassThrough();

      docker.modem.demuxStream(
        stream,
        fromContainerStdout,
        fromContainerStderr
      );

      fromContainerStdout.on("data", (d: Buffer) => {
        w.send(d);
      });
      fromContainerStderr.on("data", (d: Buffer) => {
        w.send(d);
      });

      stream.on("end", () => {
        console.log("**Session ended**");
      });
    }
  );
};

export type ContainerStatus =
  | "restarting"
  | "exited"
  | "created"
  | "removing"
  | "paused"
  | "running"
  | "dead";

export const checkPlaygroundStatus = async (
  id: string,
  status: ContainerStatus | ContainerStatus[]
) => {
  try {
    const containers = await docker.listContainers({
      filters: {
        status: typeof status === "string" ? [status] : status,
        label: [`playgroundId=${id}`],
      },
    });

    if (!containers.length) {
      return false;
    }

    if (containers.length > 1) {
      // TODO: handle it
      return false;
    }

    const c = containers[0];
    if (typeof status === "string") {
      return c.State === status;
    }

    return status.includes(c.State as ContainerStatus);
  } catch (e) {
    console.log("error while getting container status");
  }
};

function addSubdomain(sub: string, toPort: number, ws = false) {
  return `${ws ? "ws" : "http"}://${sub}.${env.DOMAIN} -> :${toPort}`;
}

export const createPlaygroundContainer = async (
  id: string,
  template: TemplateType
) => {
  try {
    const existingSlug = (await redis.get(`${id}_alias`)) as string | undefined;
    const slug = existingSlug || uniqueSlug();

    const pgEnv = {
      TEMPLATE: template,
      UPSTASH_REDIS_REST_URL: env.UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_TOKEN: env.UPSTASH_REDIS_REST_TOKEN,
      WORK_DIR: "/home/slave/app",
      DEPS_FILE: "package.json",
      VIRTUAL_HOST1: addSubdomain(`${slug}-3001`, 3001, true),

      // Available for users
      VIRTUAL_HOST2: addSubdomain(slug, 42069),
      VIRTUAL_HOST3: addSubdomain(slug, 42069, true),
      VIRTUAL_HOST4: addSubdomain(`${slug}-42070`, 42070),
      IDLE_INTERVAL: "5",

      PG_ID: id,
      BUCKET: env.BUCKET,
      AWS_ACCESS_KEY_ID: env.ACCESS_KEY,
      AWS_SECRET_ACCESS_KEY: env.SECRET_KEY,
      REGION: env.REGION,
    };
    const envArray = Object.entries(pgEnv).map(([key, val]) => `${key}=${val}`);

    console.log(`Creating playground container with id: ${id}`);
    const container = await docker.createContainer({
      Image: "playgrounds:prod",
      name: id,
      Labels: {
        playgroundId: id,
      },
      HostConfig: {
        NetworkMode: "cdamn",
      },
      Env: envArray,
    });

    redis.set(`${id}_alias`, slug);

    console.log(`Created playground container with id: ${id}`);

    return { success: true, id: container.id, isFirstBoot: !existingSlug };
  } catch (e) {
    // @ts-expect-error
    if (e.statusCode === 409) {
      return { success: true };
    }

    return { success: false };
  }
};

export const startPlayground = async (id: string) => {
  try {
    const containers = await docker.listContainers({
      filters: {
        status: ["created", "exited", "paused"],
        label: [`playgroundId=${id}`],
      },
    });

    if (!containers.length) {
      console.log("no playground found");
      return false;
    }
    if (containers.length > 1) {
      console.log("more than 1 container for a playground!!!! shuldnt be here");
      // TODO: handle this
      return false;
    }

    const c = containers[0];
    const container = await docker.getContainer(c.Id);

    console.log(`starting playground container with id: ${id}`);
    await container.start();
    console.log(`started playground container with id: ${id}`);

    return true;
  } catch (e) {
    console.log("error while starting container");
    console.log(e);
    return false;
  }
};
