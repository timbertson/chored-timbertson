import { run } from '../deps/cmd.ts'
import * as Render from '../deps/render.ts'
import * as Workflow from '../deps/workflow.ts'
import bump from '../deps/bump.ts'
import * as Update from '../deps/self_update.ts'
import * as git from '../deps/git.ts'
import * as Docker from '../deps/docker.ts'
import { merge, trimIndent } from '../deps/util.ts'
import { Options as ImportMapOptions, importMap } from '../deps/localImportMap.ts'

type ScalaMajor = 2 | 3

export interface Options {
	repo : string,
	docker?: Partial<DockerOptions>,
	scalaMajorVersions?: Array<ScalaMajor>,
	scala2Version?: string,
	scala3Version?: string,
	strictPluginOverride?: string,
}

export interface DockerOptions {
	cmd: Array<string>,
	workdir: string,
	initRequires: Array<string>,
	initTargets: Array<string>,
	updateRequires: Array<string>,
	updateTargets: Array<string>,
	buildRequires: Array<string>,
	buildTargets: Array<string>,
	builderSetup: Array<Docker.Step>,
}

const jdkTag = "eclipse-temurin-jammy-17.0.10_7"

const defaultSbtVersion = "1.10.1"

const defaultScala2Version = "2.13.14"

const defaultScala3Version = "3.4.2"

function getScalaVersion(m: ScalaMajor, opts: Options): string {
	if (m == 3) {
		return opts.scala3Version ?? defaultScala3Version
	} else {
		return opts.scala2Version ?? defaultScala2Version
	}
}

function scalaVersionVal(m: ScalaMajor, opts: Options): string {
	return `val scala${m}Version = "${getScalaVersion(m, opts)}"`
}

function scalaVersions(opts: Options): Array<string> {
	return (opts.scalaMajorVersions ?? [2]).map(m => getScalaVersion(m, opts))
}

export const defaultDockerOptions: DockerOptions = {
	cmd: [],
	workdir: "/app",
	initRequires: ["project"],
	initTargets: ["about"],
	updateRequires: ["build.sbt", "release.sbt"],
	updateTargets: ["update"],
	buildRequires: [],
	buildTargets: [],
	builderSetup: [],
}

function dockerChores(projectOpts: Options) {
	const opts = merge(defaultDockerOptions, projectOpts?.docker ?? {})

	const sbtImage = Docker.image(
			"sbtscala/scala-sbt",
			`${jdkTag}_${defaultSbtVersion}_${scalaVersions(projectOpts)[0]}`
		)

	function copyFiles(paths: string[]): Docker.Step[] {
		return paths.map(p => Docker.Step.copy(p, p))
	}

	function runSbt(deps: string[], targets: string[]): Docker.Step[] {
		if (targets.length === 0) {
			return []
		} else {
			return copyFiles(deps).concat([Docker.Step.run(['sbt'].concat(targets))])
		}
	}

	const builder = Docker.stage('builder', { from: sbtImage })
		.workdir(opts.workdir)
		.pushAll(opts.builderSetup)
		.pushAll(runSbt(opts.initRequires, opts.initTargets))
		.pushAll(runSbt(opts.updateRequires, opts.updateTargets))
		.pushAll(runSbt(opts.buildRequires, opts.buildTargets))

	const spec: Docker.Spec = {
		url: `ghcr.io/timbertson/${projectOpts.repo}`,
		stages: [ builder ]
	}

	return {
		async login(opts: { user: string, token: string }) {
			await run([
				'docker', 'login', 'ghcr.io', '-u', opts.user, '--password-stdin'
			], { stdin: { contents: opts.token } })
		},

		async build(_: {}) {
			await Docker.standardBuild(spec)
		},

		async default(_: {}) {
			await Docker.standardBuild(spec)
		},

		async run(opts: { args?: string[] }) {
			await Docker.run({
				image: Docker.imageForStage(spec, 'last'),
				cmd: opts.args,
				workDir: '/workspace',
				bindMounts: [
					{ path: Deno.cwd(), containerPath: '/workspace' },
				]
			})
		},

		print(_: {}) {
			console.log(Docker.render(spec))
		}
	}
}

function files(opts: Options): Render.File[] {
	return [
		new Render.CFile('project/sonatype.sbt', trimIndent(`
			addSbtPlugin("com.github.sbt" % "sbt-pgp" % "2.2.1")
			addSbtPlugin("org.xerial.sbt" % "sbt-sonatype" % "3.11.1")
		`)),
		new Render.CFile('project/src/main/scala/PublishSettings.scala', trimIndent(`
			import sbt._
			import Keys._
			import xerial.sbt.Sonatype.SonatypeKeys._
			import xerial.sbt.Sonatype.sonatypeCentralHost

			ThisBuild / sonatypeCredentialHost := sonatypeCentralHost

			object ScalaProject {
				val hiddenProjectSettings = Seq(
					publish / skip := true,
				)
			
				def publicProjectSettings = Seq(
					publishTo := sonatypePublishToBundle.value,
					publishMavenStyle := true,
					Test / publishArtifact := false,
				)

				${(opts.scalaMajorVersions ?? []).map(m => scalaVersionVal(m, opts)).join("\n				")}
			}
		`)),
		new Render.CFile('release.sbt', trimIndent(`
			import scala.util.Try

			ThisBuild / scalaVersion := "${scalaVersions(opts)[0]}"
			ThisBuild / organization := "net.gfxmonk"
			sonatypeProfileName := "net.gfxmonk"

			ThisBuild / version := {
				def make(v: String, snapshot: Boolean) = if (snapshot) v + "-SNAPSHOT" else v
				def isSnapshot: Try[Boolean] = sys.env.get("SNAPSHOT").map {
					case "true" => true
					case "false" => false
					// NOTE: this is an abort, not a Try.Failure
					case other => throw new RuntimeException(s"Invalid $$SNAPSHOT value: $other")
				}.toRight(new RuntimeException("$SNAPSHOT required")).toTry

				def fileVersion = {
					// from file, we assume snapshot since that's the dev env
					val base = Try(IO.read(new File("VERSION")).trim()).toOption
					base.map { v => make(v, isSnapshot.getOrElse(true)) }
				}
				def envVersion = {
					// from env, we require $SNAPSHOT to be set as well
					sys.env.get("VERSION").map(v => make(v, isSnapshot.get))
				}

				envVersion.orElse(fileVersion).getOrElse(make("0.0.0", true))
			}

			ThisBuild / homepage := Some(url(s"https://github.com/timbertson/${opts.repo}"))
			ThisBuild / scmInfo := Some(
				ScmInfo(
					url("https://github.com/timbertson/${opts.repo}"),
					s"scm:git@github.com:timbertson/${opts.repo}.git"
				)
			)

			credentials += Credentials(
				"Sonatype Nexus Repository Manager",
				"oss.sonatype.org",
				sys.env.getOrElse("SONATYPE_USER", "nobody"),
				sys.env.getOrElse("SONATYPE_PASSWORD", "******"))

			ThisBuild / licenses := Seq("MIT" -> url("http://www.opensource.org/licenses/mit-license.php"))

			ThisBuild / developers := List(
				Developer(
					id    = "gfxmonk",
					name  = "Tim Cuthbertson",
					email = "tim@gfxmonk.net",
					url   = url("http://gfxmonk.net")
				)
			)
		`)),
		new Render.CFile('project/strict.sbt', trimIndent(`
			addSbtPlugin("io.github.davidgregory084" % "sbt-tpolecat" % "0.1.20")
			${opts.strictPluginOverride ?? 'addSbtPlugin("net.gfxmonk" % "sbt-strict-scope" % "3.1.0")'}
		`)),

		new Render.CFile('project/build.properties', `sbt.version=${defaultSbtVersion}`),

		new Render.TextFile('.dockerignore', trimIndent(`
			.git
			target/
		`)),

		new Render.YAMLFile('.github/workflows/ci.yml', Workflow.ciWorkflow(
			Workflow.chores([
				{ module: 'docker', name: 'login', opts: { user: Workflow.expr('github.actor'), token: Workflow.secret('GITHUB_TOKEN') } },
				{ name: 'ci', opts: { docker: true } },
				{ name: 'requireClean' },
			])
		)),

		new Render.YAMLFile('.github/workflows/self-update.yml', (():Workflow.Workflow => ({
			on: {
				workflow_dispatch: {},
				schedule: [ { cron: '0 0 * * 1,4' } ],
			},
			jobs: {
				'self-update': {
					'runs-on': 'ubuntu-latest',
					steps: Workflow.chores([
						{ name: 'selfUpdate', opts: { mode: 'pr', githubToken: Workflow.secret('GITHUB_TOKEN') } },
					]),
				},
			},
		}
		))())

	]
}

export default function(opts: Options) {
	const Self = {
		docker: dockerChores(opts),

		async release(_: {}): Promise<void> {
			await run(['sbt', '++publishSigned', 'sonatypeBundleRelease'], { env: { 'SNAPSHOT': 'false' } })
		},

		async requireClean(_: {}): Promise<void> {
			await git.requireClean()
		},

		async ci(opts: { docker?: boolean }): Promise<void> {
			const runTests = async () => {
				const sbtCommand = ['sbt', 'strict compile', 'test']
				if (opts.docker) {
					await Self.docker.build({})
					await Self.docker.run({ args: sbtCommand })
				} else {
					await run(sbtCommand)
				}
			}

			await Promise.all([
				runTests(),
				Self.render({}),
			])
		},
		
		async selfUpdate(updateOpts: { mode?: Update.Mode, githubToken?: string }): Promise<void> {
			await Update.standardSelfUpdate({
				mode: updateOpts.mode ?? 'commit',
				commitMessage: 'chore: update',
				pr: {
					baseBranch: 'main',
					branchName: 'self-update',
					githubToken: updateOpts.githubToken,
					prTitle: '[bot] self-update',
					prBody: ':robot:',
					repository: {
						owner: 'timbertson',
						name: opts.repo
					}
				},
				update: (async () => {
					await Self.bump({})
				}),
			})
		},

		async render(_: {}) {
			await Render.render(files(opts))
		},

		async localImportMap(opts: ImportMapOptions) {
			await importMap(opts, {
				chored: '../chored',
				"chored-timbertson": '../chored-timbertson',
			})
		},

		bump,
	}
	return Self
}
