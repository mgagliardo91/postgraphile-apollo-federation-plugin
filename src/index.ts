import {
  makeExtendSchemaPlugin,
  makePluginByCombiningPlugins,
  gql,
  ExtensionDefinition,
} from "graphile-utils";
import { Build, Context, Plugin } from "graphile-build";
import printFederatedSchema from "./printFederatedSchema";
import { ObjectTypeDefinition, Directive, StringValue } from "./AST";
import { PgAttribute, QueryBuilder } from "graphile-build-pg";
import {
  DirectiveNode,
  GraphQLFieldConfigMap,
  GraphQLObjectTypeConfig,
  ObjectTypeDefinitionNode,
} from "graphql";

/**
 * This plugin installs the schema outlined in the Apollo Federation spec, and
 * the resolvers and types required. Comments have been added to make things
 * clearer for consumers, and the Apollo fields have been deprecated so that
 * users unconcerned with federation don't get confused.
 *
 * https://www.apollographql.com/docs/apollo-server/federation/federation-spec/#federation-schema-specification
 */
const SchemaExtensionPlugin = makeExtendSchemaPlugin(
  (build: Build): ExtensionDefinition => {
    const {
      graphql: { GraphQLScalarType, getNullableType },
      resolveNode,
      $$isQuery,
      $$nodeType,
      getTypeByName,
      scopeByType,
      inflection,
      nodeIdFieldName,
      pgSql: sql,
      parseResolveInfo,
      pgQueryFromResolveData: queryFromResolveData,
      pgPrepareAndRun,
    } = build;
    // Cache
    let Query: unknown;
    return {
      typeDefs: gql`
        """
        Used to represent a federated entity via its keys.
        """
        scalar _Any

        """
        Used to represent a set of fields. Grammatically, a field set is a
        selection set minus the braces.
        """
        scalar _FieldSet

        """
        A union of all federated types (those that use the @key directive).
        """
        union _Entity

        """
        Describes our federated service.
        """
        type _Service {
          """
          The GraphQL Schema Language definition of our endpoint including the
          Apollo Federation directives (but not their definitions or the special
          Apollo Federation fields).
          """
          sdl: String
            @deprecated(reason: "Only Apollo Federation should use this")
        }

        extend type Query {
          """
          Fetches a list of entities using their representations; used for Apollo
          Federation.
          """
          _entities(representations: [_Any!]!): [_Entity]!
            @deprecated(reason: "Only Apollo Federation should use this")
          """
          Entrypoint for Apollo Federation to determine more information about
          this service.
          """
          _service: _Service!
            @deprecated(reason: "Only Apollo Federation should use this")
        }

        directive @extends on OBJECT | INTERFACE
        directive @external on FIELD_DEFINITION
        directive @requires(fields: _FieldSet!) on FIELD_DEFINITION
        directive @provides(fields: _FieldSet!) on FIELD_DEFINITION
        directive @key(fields: _FieldSet!) on OBJECT | INTERFACE
      `,
      resolvers: {
        Query: {
          _entities(data, { representations }, context, resolveInfo) {
            const { pgClient } = context;
            const {
              graphile: { fieldContext },
            } = resolveInfo;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return representations.map(async (representation: any) => {
              if (!representation || typeof representation !== "object") {
                throw new Error("Invalid representation");
              }

              const { __typename, [nodeIdFieldName]: nodeId } = representation;
              if (!__typename) {
                throw new Error(
                  "Failed to interpret representation, no typename",
                );
              }
              if (nodeId) {
                if (typeof nodeId !== "string") {
                  throw new Error(
                    "Failed to interpret representation, invalid nodeId",
                  );
                }
                return resolveNode(
                  nodeId,
                  build,
                  fieldContext,
                  data,
                  context,
                  resolveInfo,
                );
              } else {
                const type = getTypeByName(__typename);
                const { pgIntrospection: table } = scopeByType.get(type);

                if (!table.primaryKeyConstraint) {
                  throw new Error("Failed to interpret representation");
                }
                const {
                  primaryKeyConstraint: { keyAttributes },
                } = table;

                const whereClause = sql.fragment`(${sql.join(
                  keyAttributes.map(
                    (attr: PgAttribute) =>
                      sql.fragment`${sql.identifier(attr.name)} = ${sql.value(
                        representation[inflection.column(attr)],
                      )}`,
                  ),
                  ") and (",
                )})`;

                const resolveData = fieldContext.getDataFromParsedResolveInfoFragment(
                  parseResolveInfo(resolveInfo),
                  type,
                );

                const query = queryFromResolveData(
                  sql.identifier(table.namespace.name, table.name),
                  undefined,
                  resolveData,
                  {
                    useAsterisk: false, // Because it's only a single relation, no need
                  },
                  (queryBuilder: QueryBuilder) => {
                    queryBuilder.where(whereClause);
                  },
                  context,
                  resolveInfo.rootValue,
                );

                const { text, values } = sql.compile(query);

                const {
                  rows: [row],
                } = await pgPrepareAndRun(pgClient, text, values);

                return { [$$nodeType]: __typename, ...row };
              }
            });
          },

          _service(_, _args, _context, { schema }) {
            return schema;
          },
        },

        _Service: {
          sdl(schema) {
            return printFederatedSchema(schema);
          },
        },

        _Entity: {
          __resolveType(value) {
            // This uses the same resolution as the Node interface,
            // which can be found in graphile-build's NodePlugin
            if (value === $$isQuery) {
              if (!Query) Query = getTypeByName(inflection.builtin("Query"));
              return Query;
            } else if (value[$$nodeType]) {
              return getNullableType(value[$$nodeType]);
            }
          },
        },

        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        _Any: new GraphQLScalarType({
          name: "_Any",
          serialize(value: unknown) {
            return value;
          },
        }),
      },
    };
  },
);

/*
 * This plugin adds the `@key(fields: "nodeId")` directive to the types that
 * implement the Node interface, and adds these types to the _Entity union
 * defined above.
 */
const AddKeyPlugin: Plugin = (builder) => {
  // Extend the Graphile build object.
  // The build object will be available throughout the
  // current schema build and is passed to all hooks.
  builder.hook("build", (build) => {
    // The names of entities to use for federation.
    build.EntityNamesToFederate = [];

    // The GraphQLObjectTypes to add to the _Entity union type for federation.
    build.graphqlObjectTypesForEntityType = [];

    return build;
  });

  builder.hook(
    "GraphQLObjectType",
    (
      type: GraphQLObjectTypeConfig<unknown, unknown>,
      build: Build,
      context: Context<GraphQLObjectTypeConfig<unknown, unknown>>,
    ) => {
      const {
        scope: { pgIntrospection, isPgRowType },
      } = context;

      const { inflection } = build;

      if (
        !(
          isPgRowType &&
          pgIntrospection.isSelectable &&
          pgIntrospection.namespace &&
          pgIntrospection.primaryKeyConstraint
        )
      ) {
        return type;
      }

      const primaryKeyNames = pgIntrospection.primaryKeyConstraint.keyAttributes.map(
        (attr: PgAttribute) => inflection.column(attr),
      );

      if (!primaryKeyNames.length) {
        return type;
      }

      const astNode = {
        ...Object.assign({}, ObjectTypeDefinition(type)),
        ...type.astNode,
      };

      (astNode.directives as DirectiveNode[]).push(
        Directive("key", { fields: StringValue(primaryKeyNames.join(" ")) }),
      );

      type.astNode = astNode as ObjectTypeDefinitionNode;

      if (!build.EntityNamesToFederate.includes(type.name)) {
        // Add type name to list so we can use it later to get
        // it's GraphQLObjectType and add it to the _Entity union type.
        build.EntityNamesToFederate.push(type.name);
      }

      return type;
    },
  );

  builder.hook(
    "GraphQLObjectType:fields",
    (
      fields: GraphQLFieldConfigMap<unknown, unknown>,
      build: Build,
      context: Context<GraphQLFieldConfigMap<unknown, unknown>>,
    ) => {
      const {
        Self,
        scope: { isRootQuery },
      } = context;

      // Drop the `query` field. If we don't remove it,
      // it will clash with other federated services `query` fields.
      if (isRootQuery) {
        const { query, ...rest } = fields;
        return rest;
      }

      // Skip if not an entity we want to federate.
      if (!build.EntityNamesToFederate.includes(Self.name)) {
        return fields;
      }

      if (
        !(build.graphqlObjectTypesForEntityType as []).some(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (e: any) => e.name === Self.name,
        )
      ) {
        // Add this to the list of types to be in the _Entity union.
        build.graphqlObjectTypesForEntityType.push(Self);
      }

      return fields;
    },
  );

  // Find out what types implement the Node interface
  builder.hook("GraphQLObjectType:interfaces", (interfaces, build, context) => {
    const { getTypeByName, inflection, nodeIdFieldName } = build;
    const {
      GraphQLObjectType: spec,
      Self,
      scope: { isRootQuery },
    } = context;
    const NodeInterface = getTypeByName(inflection.builtin("Node"));

    /*
     * We only want to add federation to types that implement the Node
     * interface, and aren't the Query root type.
     */
    if (isRootQuery || !NodeInterface || !interfaces.includes(NodeInterface)) {
      return interfaces;
    }

    // Add this to the list of types to be in the _Entity union
    build.graphqlObjectTypesForEntityType.push(Self);

    /*
     * We're going to add the `@key(fields: "nodeId")` directive to this type.
     * First, we need to generate an `astNode` as if the type was generated
     * from a GraphQL SDL initially; then we assign this astNode to to the type
     * (via type mutation, ick) so that Apollo Federation's `printSchema` can
     * output it.
     */
    const astNode = {
      ...Object.assign({}, ObjectTypeDefinition(spec)),
      ...Self.astNode,
    };

    astNode.directives.push(
      Directive("key", { fields: StringValue(nodeIdFieldName) }),
    );

    Self.astNode = astNode;

    // We're not changing the interfaces, so return them unmodified.
    return interfaces;
  });

  // Add our collected types to the _Entity union
  builder.hook("GraphQLUnionType:types", (types, build, context) => {
    // If it's not the _Entity union, don't change it.
    if (context.Self.name !== "_Entity") {
      return types;
    }

    // Add our types to the entity types
    return [...types, ...build.graphqlObjectTypesForEntityType];
  });
};

// Our federation implementation combines these two plugins:
export default makePluginByCombiningPlugins(
  SchemaExtensionPlugin,
  AddKeyPlugin,
);
